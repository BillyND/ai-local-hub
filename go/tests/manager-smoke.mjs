import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const root = await mkdtemp(join(tmpdir(), "ai-local-hub-go-smoke-"));
const manager =
  process.env.GO_MANAGER_BIN || "/tmp/ai-local-hub-go-manager-dev";
const worker = process.env.GO_WORKER_BIN || "/tmp/ai-local-hub-go-worker-dev";
const child = spawn(
  manager,
  [
    "--local-only",
    "--no-open",
    "--port",
    "0",
    "--worker",
    worker,
    "--web",
    resolve("dist/web"),
  ],
  {
    env: {
      ...process.env,
      WORKSPACE_TOOLS_CONFIG_FILE: join(root, "config.json"),
      WORKSPACE_TOOLS_CACHE_DIR: join(root, "cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let stdout = "",
  stderr = "";
child.stderr.on("data", (x) => (stderr += x));
let started, failed;
const startup = new Promise((resolve, reject) => {
  started = resolve;
  failed = reject;
});
child.stdout.on("data", (x) => {
  stdout += x;
  const link = stdout.match(
    /Open: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/,
  )?.[1];
  if (link) started(link);
});
child.on("error", failed);
child.on("exit", (code) =>
  failed(new Error(`manager exited ${code}: ${stderr}`)),
);
async function waitUntil(fn, name) {
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw Error(`timed out ${name} ${stderr}`);
}
try {
  const link = await Promise.race([
    startup,
    new Promise((_, rej) =>
      setTimeout(() => rej(Error("startup timeout " + stderr)), 15000),
    ),
  ]);
  const origin = new URL(link).origin;
  assert.equal((await fetch(origin + "/api/state")).status, 401);
  assert.equal((await fetch(link, { redirect: "manual" })).status, 302);
  const login = await fetch(link, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("wtm_session="));
  const page=await fetch(origin+'/',{headers:{cookie}});
  assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/<div id="root"><\/div>/);
  const appBundle=html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(appBundle,'missing React entrypoint');
  assert.equal((await fetch(new URL(appBundle,origin),{headers:{cookie}})).status,200);
  const traversal=await fetch(origin+'/%2e%2e/package.json',{headers:{cookie}});
  assert.notEqual(traversal.status,200,'static traversal exposed project files');
  const api = async (method, path, body) => {
    const res = await fetch(origin + "/api" + path, {
      method,
      headers: {
        cookie,
        ...(method === "GET" ? {} : { origin }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, data: raw ? JSON.parse(raw) : null };
  };
  assert.equal((await api("GET", "/state")).data.instances.length, 0);
  const abortSSE = new AbortController();
  const sseResponse = await fetch(origin + "/api/events", {headers:{cookie},signal:abortSSE.signal});
  assert.equal(sseResponse.status,200);
  assert.match(sseResponse.headers.get('content-type'),/text\/event-stream/);
  const sseReader = sseResponse.body.getReader();
  const sseEvent = (async()=>{let all='';while(!all.includes('"type":"instances"')){const part=await sseReader.read();if(part.done)throw Error('SSE closed early');all+=new TextDecoder().decode(part.value)}return all})();
  const form = {
    name: "  primary  ",
    workspaceRoot: root,
    tunnelId: "test-tunnel",
    apiKey: "secret-only-for-testing",
  };
  const created = await api("POST", "/instances", form);
  assert.equal(created.status, 201, created.raw);
  assert.match(await Promise.race([sseEvent,new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE not delivered')),3000))]),/instances/);
  abortSSE.abort();
  const id = created.data.id;
  assert.equal(created.data.name, "primary");
  assert.ok(!created.raw.includes(form.apiKey));
  assert.equal((await api("POST", "/instances", form)).status, 400);
  assert.ok(
    (await readFile(join(root, "config.json"), "utf8")).includes(form.apiKey),
  );
  const denied = await fetch(origin + "/api/instances", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify(form),
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await api("PUT", `/instances/${id}`, {
        name: "primary-edited",
        workspaceRoot: root,
        tunnelId: "test-tunnel",
      })
    ).status,
    200,
  );
  assert.equal((await api("POST", `/instances/${id}/start`, {})).status, 200);
  const view = await waitUntil(async () => {
    const s = await api("GET", "/state");
    const v = s.data.instances.find((i) => i.id === id);
    if (v?.status.state === "error") throw Error(JSON.stringify(v.status));
    return v?.status.state === "running" ? v : null;
  }, "go worker startup");
  assert.match(view.status.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const c = new Client({ name: "go-migration-integration", version: "1" });
  try {
    await c.connect(
      new StreamableHTTPClientTransport(new URL(view.status.url)),
    );
    const tools = (await c.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    const w = await c.callTool({
      name: "write",
      arguments: { path: "migrated.txt", content: "hello-go" },
    });
    assert.notEqual(w.isError, true, JSON.stringify(w));
    assert.equal(
      await readFile(join(root, "migrated.txt"), "utf8"),
      "hello-go",
    );
    const rd = await c.callTool({
      name: "read",
      arguments: { path: "migrated.txt" },
    });
    assert.match(rd.content[0].text, /hello-go/);
    const edit = await c.callTool({
      name: "edit",
      arguments: {
        path: "migrated.txt",
        edits: [{ oldText: "hello-go", newText: "updated-go" }],
      },
    });
    assert.notEqual(edit.isError, true, JSON.stringify(edit));
    assert.equal(
      await readFile(join(root, "migrated.txt"), "utf8"),
      "updated-go",
    );
    const duplicate = await c.callTool({
      name: "edit",
      arguments: {
        path: "migrated.txt",
        edits: [{ oldText: "missing", newText: "bad" }],
      },
    });
    assert.equal(duplicate.isError, true);
    const shell = await c.callTool({
      name: "bash",
      arguments: { command: "printf go-bash" },
    });
    assert.notEqual(shell.isError, true, JSON.stringify(shell));
    assert.match(shell.content[0].text, /go-bash/);
    for (const name of ["find", "ls", "grep"]) {
      const argumentsByName = {
        find: { pattern: "*.txt" },
        ls: { path: "." },
        grep: { pattern: "updated-go" },
      };
      const r = await c.callTool({ name, arguments: argumentsByName[name] });
      assert.notEqual(r.isError, true, JSON.stringify(r));
    }
  } finally {
    await c.close();
  }
  assert.equal((await api("GET", `/instances/${id}/logs`)).status, 200);
  assert.equal((await api("POST", `/instances/${id}/stop`, {})).status, 200);
  await waitUntil(
    async () =>
      (await api("GET", "/state")).data.instances[0].status.state === "stopped",
    "Go worker stop",
  );
  const other = join(root, "second");
  await mkdir(other);
  assert.equal(
    (
      await api("POST", "/instances", {
        name: "second",
        workspaceRoot: other,
        tunnelId: "different-tunnel",
        apiKey: "other-secret",
      })
    ).status,
    201,
  );
  assert.equal((await api("POST", "/start-all", {})).status, 204);
  await waitUntil(async () => {
    const all = (await api("GET", "/state")).data.instances;
    return all.every((x) => x.status.state === "running");
  }, "multiple independent workers");
  assert.equal((await api("POST", "/stop-all", {})).status, 204);
  await waitUntil(
    async () =>
      (await api("GET", "/state")).data.instances.every(
        (x) => x.status.state === "stopped",
      ),
    "all workers stop",
  );
  assert.equal((await api("DELETE", `/instances/${id}`)).status, 204);
  assert.equal((await api("POST", "/shutdown", {})).status, 202);
  console.log(
    "GO Manager + MCP contract smoke: PASS (auth, CRUD, tools, 2 workers, start/stop)",
  );
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 6500),
    ),
  ]);
  await rm(root, { recursive: true, force: true });
}
