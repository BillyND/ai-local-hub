import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstanceManager } from "../src/instance-manager.js";
import { acquireManagerLock } from "../src/manager-lock.js";
import { startWebServer, type WebServer } from "../src/manager-api/server.js";

const entryScript = new URL("../src/worker-main.ts", import.meta.url).pathname;
const SECRET = "sk-very-secret-key";

interface Fixture {
  root: string;
  configPath: string;
  workspace: string;
  server: WebServer;
  manager: InstanceManager;
  token: string;
  shutdowns: number;
  cookie: string;
  origin: string;
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-api-"));
  const staticDir = join(root, "static");
  const workspace = join(root, "ws");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ui</title>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log(1)");
  await writeFile(join(root, "secret.txt"), "top secret");
  const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript });
  const token = "t".repeat(64);
  const state = { shutdowns: 0 };
  const server = await startWebServer({
    manager,
    configPath: join(root, "config.json"),
    localOnly: true,
    staticDir,
    token,
    version: "9.9.9",
    port: 0,
    strict: false,
    onShutdownRequested: () => void (state.shutdowns += 1),
  });
  const fixture = {
    root,
    configPath: join(root, "config.json"),
    workspace,
    server,
    manager,
    token,
    cookie: `wtm_session=${token}`,
    origin: `http://127.0.0.1:${server.port}`,
    get shutdowns() {
      return state.shutdowns;
    },
  };
  try {
    await run(fixture);
  } finally {
    await manager.stopAll();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

function request(
  f: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; origin?: string | null; host?: string; contentType?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.cookie !== null) headers.cookie = options.cookie ?? f.cookie;
  if (options.origin !== null && method !== "GET") headers.origin = options.origin ?? f.origin;
  if (options.host) headers.host = options.host;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (payload !== undefined) headers["content-type"] = options.contentType ?? "application/json";
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const req = http.request({ host: "127.0.0.1", port: f.server.port, method, path, headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
    });
  });
  req.on("error", reject);
  req.end(payload);
  return promise;
}

const create = (f: Fixture, name = "work") =>
  request(f, "POST", "/api/instances", {
    body: { name, workspaceRoot: f.workspace, tunnelId: `tunnel_${name}`, apiKey: SECRET },
  });

async function waitFor<T>(task: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await task();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("API requires the session cookie; the token link sets it and redirects", async () => {
  await withFixture(async (f) => {
    assert.equal((await request(f, "GET", "/api/state", { cookie: null })).status, 401);
    assert.equal((await request(f, "GET", "/api/state", { cookie: "wtm_session=wrong" })).status, 401);
    const link = await request(f, "GET", `/?token=${f.token}`, { cookie: null });
    assert.equal(link.status, 302);
    assert.equal(link.headers.location, "/");
    const setCookie = String(link.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal((await request(f, "GET", "/?token=wrong", { cookie: null })).status, 401);
    const state = await request(f, "GET", "/api/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.instances, []);
    assert.equal(state.json.version, "9.9.9");
    assert.equal(state.json.localOnly, true);
  });
});

test("rejects foreign Host headers, cross-origin mutations and non-JSON bodies", async () => {
  await withFixture(async (f) => {
    assert.equal((await request(f, "GET", "/api/state", { host: "evil.example" })).status, 403);
    assert.equal((await request(f, "GET", "/api/state", { host: `evil.example:${f.server.port}` })).status, 403);
    assert.equal((await request(f, "GET", "/api/state", { host: `localhost:${f.server.port}` })).status, 200);
    const body = { name: "x", workspaceRoot: f.workspace, tunnelId: "t", apiKey: "k" };
    assert.equal((await request(f, "POST", "/api/instances", { body, origin: null })).status, 403);
    assert.equal((await request(f, "POST", "/api/instances", { body, origin: "http://evil.example" })).status, 403);
    assert.equal((await request(f, "POST", "/api/instances", { body, contentType: "text/plain" })).status, 415);
    assert.equal((await request(f, "DELETE", "/api/instances/x", { origin: "http://evil.example" })).status, 403);
    assert.equal((await request(f, "GET", "/api/state")).json.instances.length, 0, "nothing was created");
  });
});

test("instances are created, edited and deleted without ever returning the API key", async () => {
  await withFixture(async (f) => {
    const created = await create(f);
    assert.equal(created.status, 201);
    assert.equal(created.json.name, "work");
    assert.equal(created.json.hasApiKey, true);
    assert.equal("apiKey" in created.json, false);
    const id = created.json.id as string;
    assert.match(await readFile(f.configPath, "utf8"), new RegExp(SECRET), "key is stored");

    const duplicate = await create(f);
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.json.error, /already exists/);
    const bad = await request(f, "POST", "/api/instances", { body: { name: 1 } });
    assert.equal(bad.status, 400);

    const edited = await request(f, "PUT", `/api/instances/${id}`, {
      body: { name: "renamed", workspaceRoot: f.workspace, tunnelId: "tunnel_work" },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.name, "renamed");
    assert.match(await readFile(f.configPath, "utf8"), new RegExp(SECRET), "empty key keeps the stored one");

    const everything = [
      (await request(f, "GET", "/api/state")).body,
      (await request(f, "GET", `/api/instances/${id}/logs`)).body,
      edited.body,
    ].join("\n");
    assert.equal(everything.includes(SECRET), false);

    assert.equal((await request(f, "PUT", "/api/instances/nope", { body: { name: "a", workspaceRoot: f.workspace, tunnelId: "t" } })).status, 404);
    assert.equal((await request(f, "DELETE", `/api/instances/${id}`)).status, 204);
    assert.equal((await request(f, "GET", "/api/state")).json.instances.length, 0);
    assert.equal((await request(f, "DELETE", `/api/instances/${id}`)).status, 404);
  });
});

test("start and stop run a real worker; logs and status are served", async () => {
  await withFixture(async (f) => {
    const id = (await create(f)).json.id as string;
    assert.equal((await request(f, "POST", `/api/instances/${id}/start`)).status, 200);
    const running = await waitFor(async () => {
      const view = (await request(f, "GET", "/api/state")).json.instances[0];
      return view.status.state === "running" ? view : undefined;
    }, "instance running");
    assert.match(running.status.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const logs = (await request(f, "GET", `/api/instances/${id}/logs`)).json.lines as string[];
    assert.ok(logs.some((l) => l.includes("MCP ready")));
    assert.equal(logs.join("\n").includes(SECRET), false);

    assert.equal((await request(f, "POST", `/api/instances/${id}/stop`)).status, 200);
    await waitFor(async () => {
      const view = (await request(f, "GET", "/api/state")).json.instances[0];
      return view.status.state === "stopped" ? view : undefined;
    }, "instance stopped");
    assert.equal((await request(f, "POST", "/api/instances/nope/start")).status, 404);
  });
});

test("start-all and stop-all drive every instance", async () => {
  await withFixture(async (f) => {
    await create(f, "a");
    await create(f, "b");
    assert.equal((await request(f, "POST", "/api/start-all")).status, 204);
    await waitFor(async () => {
      const list = (await request(f, "GET", "/api/state")).json.instances as any[];
      return list.every((o) => o.status.state === "running") ? list : undefined;
    }, "both running");
    assert.equal((await request(f, "POST", "/api/stop-all")).status, 204);
    await waitFor(async () => {
      const list = (await request(f, "GET", "/api/state")).json.instances as any[];
      return list.every((o) => o.status.state === "stopped") ? list : undefined;
    }, "both stopped");
  });
});

test("server-sent events deliver instance, status and log updates", async () => {
  await withFixture(async (f) => {
    const events: any[] = [];
    const req = http.get(
      { host: "127.0.0.1", port: f.server.port, path: "/api/events", headers: { cookie: f.cookie } },
      (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
          }
        });
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      const id = (await create(f)).json.id as string;
      await request(f, "POST", `/api/instances/${id}/start`);
      await waitFor(async () => (events.some((e) => e.type === "status" && e.status.state === "running") ? true : undefined), "running status event");
      assert.ok(events.some((e) => e.type === "instances" && e.instances.length === 1));
      assert.ok(events.some((e) => e.type === "log" && e.id === id && e.line.includes("MCP ready")));
      assert.equal(JSON.stringify(events).includes(SECRET), false);
    } finally {
      req.destroy();
    }
  });
});

test("event stream needs authentication", async () => {
  await withFixture(async (f) => {
    assert.equal((await request(f, "GET", "/api/events", { cookie: null })).status, 401);
  });
});

test("folder browser lists directories only and validates the path", async () => {
  await withFixture(async (f) => {
    await mkdir(join(f.workspace, "alpha"));
    await mkdir(join(f.workspace, "beta"));
    await mkdir(join(f.workspace, ".hidden"));
    await writeFile(join(f.workspace, "file.txt"), "x");
    const listing = await request(f, "GET", `/api/fs?path=${encodeURIComponent(f.workspace)}`);
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.json.dirs, ["alpha", "beta"]);
    assert.equal(listing.json.parent, f.root);
    assert.equal((await request(f, "GET", "/api/fs?path=relative/dir")).status, 400);
    assert.equal((await request(f, "GET", `/api/fs?path=${encodeURIComponent(join(f.root, "missing"))}`)).status, 400);
    assert.equal((await request(f, "GET", "/api/fs")).status, 200, "defaults to the home directory");
  });
});

test("static files: SPA fallback, caching, security headers and no path traversal", async () => {
  await withFixture(async (f) => {
    const root = await request(f, "GET", "/");
    assert.equal(root.status, 200);
    assert.match(root.body, /<title>ui<\/title>/);
    assert.match(String(root.headers["content-security-policy"]), /default-src 'self'/);
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["cache-control"], "no-store");
    const route = await request(f, "GET", "/instances/abc");
    assert.equal(route.status, 200, "client-side routes fall back to index.html");
    const asset = await request(f, "GET", "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers["content-type"]), /javascript/);
    assert.match(String(asset.headers["cache-control"]), /immutable/);
    assert.equal((await request(f, "GET", "/assets/missing.js")).status, 404);
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt"]) {
      const reply = await request(f, "GET", path);
      assert.equal(reply.body.includes("top secret"), false, path);
    }
    assert.equal((await request(f, "POST", "/index.html", { body: {} })).status, 405);
  });
});

test("shutdown endpoint asks the manager to stop", async () => {
  await withFixture(async (f) => {
    assert.equal((await request(f, "POST", "/api/shutdown", { cookie: null })).status, 401);
    assert.equal(f.shutdowns, 0);
    assert.equal((await request(f, "POST", "/api/shutdown", { body: {} })).status, 202);
    assert.equal(f.shutdowns, 1);
  });
});

test("manager lock: a live manager blocks a second one, a stale lock is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-lock-"));
  const path = join(root, "manager.lock");
  const live = http.createServer((_req, res) => res.writeHead(401).end());
  await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
  const port = (live.address() as { port: number }).port;
  try {
    const first = await acquireManagerLock(path, { pid: process.pid, url: `http://127.0.0.1:${port}/`, token: "tok" });
    assert.equal(first.acquired, true);
    const second = await acquireManagerLock(path, { pid: 1, url: "http://127.0.0.1:1/", token: "other" });
    assert.equal(second.acquired, false);
    if (!second.acquired) assert.deepEqual(second.existing, { pid: process.pid, url: `http://127.0.0.1:${port}/`, token: "tok" });
    if (first.acquired) await first.release();
    const afterRelease = await acquireManagerLock(path, { pid: process.pid, url: `http://127.0.0.1:${port}/`, token: "new" });
    assert.equal(afterRelease.acquired, true);
    if (afterRelease.acquired) await afterRelease.release();

    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = child.pid ?? 0;
    await new Promise((resolve) => child.once("exit", resolve));
    await writeFile(path, JSON.stringify({ pid: deadPid, url: `http://127.0.0.1:${port}/`, token: "stale" }));
    const replaced = await acquireManagerLock(path, { pid: process.pid, url: "http://127.0.0.1:2/", token: "fresh" });
    assert.equal(replaced.acquired, true, "dead pid means the lock is stale");
    if (replaced.acquired) await replaced.release();
  } finally {
    live.close();
    await rm(root, { recursive: true, force: true });
  }
});
