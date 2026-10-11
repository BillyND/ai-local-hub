import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = await mkdtemp(join(tmpdir(), "ai-local-hub-go-reliability-"));
const manager =
  process.env.GO_MANAGER_BIN || "/tmp/ai-local-hub-go-manager-dev";
const worker = process.env.GO_WORKER_BIN || "/tmp/ai-local-hub-go-worker-dev";
const child = spawn(
  manager,
  [
    "--local-only",
    "--port",
    "0",
    "--no-open",
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
let err = "",
  out = "";
child.stderr.on("data", (s) => (err += s));
let started, failed;
const boot = new Promise((a, b) => {
  started = a;
  failed = b;
});
child.stdout.on("data", (s) => {
  out += s;
  const link = out.match(
    /Open: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/,
  )?.[1];
  if (link) started(link);
});
child.on("error", failed);
const wait = async (fn, name, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw Error(`timeout ${name}; stderr ${err}`);
};
const activeChildren = () => {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  }).stdout;
  return ps
    .split("\n")
    .map((x) => x.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .filter((x) => Number(x[2]) === child.pid && x[3].includes(worker))
    .map((x) => Number(x[1]));
};
const alive = (pid) =>
  spawnSync("ps", ["-p", String(pid), "-o", "pid="], {
    encoding: "utf8",
  }).stdout.trim().length > 0;
try {
  const link = await Promise.race([
    boot,
    new Promise((_, b) =>
      setTimeout(() => b(Error("boot timeout " + err)), 12000),
    ),
  ]);
  const origin = new URL(link).origin;
  const cookie = (await fetch(link, { redirect: "manual" })).headers
    .get("set-cookie")
    .split(";")[0];
  const api = async (method, path, body) => {
    const res = await fetch(origin + "/api" + path, {
      method,
      headers: {
        cookie,
        ...(method === "GET" ? {} : { origin }),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await res.text();
    return { code: res.status, data: txt ? JSON.parse(txt) : null };
  };
  const instance = await api("POST", "/instances", {
    name: "resilience",
    workspaceRoot: root,
    tunnelId: "fixture",
    apiKey: "demo-secret",
  });
  assert.equal(instance.code, 201);
  const id = instance.data.id;
  assert.equal((await api("POST", `/instances/${id}/start`, {})).code, 200);
  await wait(
    async () =>
      (await api("GET", "/state")).data.instances[0].status.state === "running",
    "first startup",
  );
  const [pid] = await wait(() => activeChildren(), "worker pid");
  assert.ok(pid && alive(pid));
  process.kill(pid, "SIGKILL");
  await wait(
    async () =>
      (await api("GET", "/state")).data.instances[0].status.state === "error",
    "worker crash detected",
  );
  assert.equal((await api("POST", `/instances/${id}/start`, {})).code, 200);
  await wait(
    async () =>
      (await api("GET", "/state")).data.instances[0].status.state === "running",
    "recovery after crash",
  );
  assert.notEqual(activeChildren()[0], pid);
  const restartPID = activeChildren()[0];
  assert.ok(restartPID && alive(restartPID));
  // Crashing only this isolated Go dev manager must close workers through stdin EOF.
  process.kill(child.pid, "SIGKILL");
  await wait(() => !alive(restartPID), "worker exit on manager death", 10000);
  console.log(
    "GO reliability smoke: PASS (worker SIGKILL detected, worker restarted, manager SIGKILL leaves no worker orphan)",
  );
} finally {
  try {
    child.stdin.end();
  } catch {}
  if (alive(child.pid)) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
