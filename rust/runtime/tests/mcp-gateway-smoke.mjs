// External MCP servers through the worker: naming, annotations, forwarding, env, timeout + cancel,
// result trimming, crash restart, failed start, and no leftover processes after the worker stops.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.platform === "win32") { console.log("mcp-gateway smoke skipped on Windows (uses sleep/process groups)"); process.exit(0); }
const root = await realpath(await mkdtemp(join(tmpdir(), "ai-local-hub-gateway-")));
const fixture = resolve("rust/runtime/tests/fixtures/fake-mcp-server.mjs");
const bin = resolve("rust/runtime/target/debug/ai-local-hub-runtime");
const servers = {
  fake: { command: process.execPath, args: [fixture, root], env: { FAKE_TOKEN: "tok-secret-123" }, timeoutSecs: 5 },
  allow: { command: process.execPath, args: [fixture, root], tools: ["echo"], trustAnnotations: true },
  broken: { command: join(root, "missing-binary") },
  off: { command: process.execPath, args: [fixture, root], enabled: false },
};
const worker = spawn(bin, ["--local-only"], {
  env: { ...process.env, WORKSPACE_ROOT: root, AI_LOCAL_HUB_AUTO_BG_SECS: "off", AI_LOCAL_HUB_MCP_SERVERS: JSON.stringify(servers) },
  stdio: ["pipe", "pipe", "pipe"],
});
const logs = [];
let buf = "", stderr = "";
worker.stderr.on("data", (c) => (stderr += c));
const ready = new Promise((resolveReady, rejectReady) => {
  worker.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "log") logs.push(event.message);
      if (event.type === "ready") resolveReady();
      if (event.type === "mcp") worker.url = event.url;
      if (event.type === "fatal") rejectReady(new Error(event.message));
    }
  });
  worker.once("exit", (code) => rejectReady(new Error(`Worker exited ${code} ${stderr}`)));
});
const exited = new Promise((r) => worker.once("exit", r));
const client = new Client({ name: "gateway-smoke", version: "1.0" });
const asText = (r) => r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "";
const until = async (check, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out: ${what}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let pids = [];
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("worker start timeout " + stderr)), 45000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(worker.url)));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const n of ["read", "bash", "fake__echo", "fake__whoami", "fake__slow", "fake__big", "fake__crash", "allow__echo"]) assert.ok(names.includes(n), `${n} missing from ${names}`);
  assert.ok(names.some((n) => /^fake__weird_name_[0-9a-f]{8}$/.test(n)), `sanitized name missing from ${names}`);
  assert.ok(!names.some((n) => n.startsWith("allow__") && n !== "allow__echo"), "allowlist ignored");
  assert.ok(!names.some((n) => n.startsWith("broken__") || n.startsWith("off__")), "failed or disabled server exposed tools");
  const tool = (n) => tools.find((t) => t.name === n);
  assert.equal(tool("fake__echo").annotations.readOnlyHint, false);
  assert.equal(tool("fake__echo").annotations.destructiveHint, true);
  assert.equal(tool("allow__echo").annotations.readOnlyHint, true);
  assert.match(tool("fake__echo").description, /^\[fake\] Echo text back/);
  assert.ok(logs.some((l) => /^Tools \(\d+\): .*fake__echo/.test(l)), "startup tool log lacks gateway tools");

  assert.equal(asText(await call("fake__echo", { text: "hi" })), "echo:hi");
  assert.equal(asText(await call("allow__echo", { text: "yo" })), "echo:yo");
  const weird = names.find((n) => n.startsWith("fake__weird_name_"));
  assert.equal(asText(await call(weird)), "weird ok");
  const who = JSON.parse(asText(await call("fake__whoami")));
  assert.equal(who.token, "tok-secret-123");
  assert.equal(who.cwd, root);
  pids.push(who.pid, who.grandchild);
  const leaked = asText(await call("bash", { command: "printenv AI_LOCAL_HUB_MCP_SERVERS || echo none" }));
  assert.match(leaked, /^none$/m, "server config with secrets leaked into the shell");

  const started = Date.now();
  const slow = await call("fake__slow", { ms: 20000 });
  assert.equal(slow.isError, true);
  assert.match(asText(slow), /did not answer within 5s; the call was cancelled/);
  assert.ok(Date.now() - started < 9000, "timeout not enforced");
  await until(() => existsSync(join(root, "slow-cancelled")), 3000, "upstream saw the cancellation");

  const big = await call("fake__big", { bytes: 9.5 * 1024 * 1024 });
  assert.notEqual(big.isError, true);
  assert.match(asText(big), /Result trimmed to fit the 10 MiB tunnel limit: text cut from/);
  assert.ok(JSON.stringify(big).length < 9 * 1024 * 1024);

  const crash = await call("fake__crash");
  assert.equal(crash.isError, true);
  assert.match(asText(crash), /disconnected during the call|is not connected/);
  await until(async () => asText(await call("fake__echo", { text: "back" })) === "echo:back", 15000, "restart after crash");
  assert.ok(logs.some((l) => /^MCP server fake exited .*restarting$/.test(l)), "restart not logged");
  pids.push(JSON.parse(asText(await call("fake__whoami"))).pid, JSON.parse(asText(await call("fake__whoami"))).grandchild);
  assert.ok(logs.some((l) => l === "[mcp:fake] fake server started"), "server stderr not forwarded");
  assert.ok(logs.some((l) => /^MCP server broken failed to start: cannot start/.test(l)), "failed start not logged");

  const unknown = await call("fake__nope").catch((e) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
  assert.equal(unknown.isError, true);
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
  if (worker.exitCode === null) worker.kill("SIGKILL");
}
pids = pids.filter((p) => p > 0);
assert.ok(pids.length >= 4, `expected server and grandchild pids, got ${pids}`);
await until(() => pids.every((p) => !alive(p)), 5000, `processes still alive after stop: ${pids.filter(alive)}`);
// Every server (including `allow`, whose pid the test never saw) was started as `node <fixture> <root>`.
const ps = await new Promise((r) => { let out = ""; const p = spawn("ps", ["-axo", "pid=,command="]); p.stdout.on("data", (c) => (out += c)); p.on("close", () => r(out)); });
assert.ok(!ps.split("\n").some((l) => l.includes(fixture) && l.includes(root)), "an upstream server outlived the worker");
// A stop while a server is still starting (slow first `npx` download) must not leave its process group behind:
// the worker has to react to stdin EOF before the manager's 10 s SIGKILL escalation.
const groupAlive = async (pgid) => {
  const out = await new Promise((r) => { let o = ""; const p = spawn("ps", ["-axo", "pgid="]); p.stdout.on("data", (c) => (o += c)); p.on("close", () => r(o)); });
  return out.split("\n").some((l) => Number(l.trim()) === pgid);
};
const slowWorker = spawn(bin, ["--local-only"], {
  env: { ...process.env, WORKSPACE_ROOT: root, AI_LOCAL_HUB_MCP_SERVERS: JSON.stringify({ slow: { command: process.execPath, args: [fixture, root], env: { FAKE_START_DELAY_MS: "20000" } } }) },
  stdio: ["pipe", "pipe", "pipe"],
});
const slowExit = new Promise((r) => slowWorker.once("exit", r));
const group = await new Promise((resolveGroup, rejectGroup) => {
  let pending = "";
  slowWorker.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let nl; (nl = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
      try { const e = JSON.parse(line); if (e.type === "child_group") resolveGroup(e.pid); } catch {}
    }
  });
  setTimeout(() => rejectGroup(new Error("no child_group event")), 10000);
});
await until(async () => groupAlive(group), 3000, "slow server group started");
const stopAt = Date.now();
slowWorker.stdin.end();
await Promise.race([slowExit, new Promise((r) => setTimeout(r, 9000))]);
assert.notEqual(slowWorker.exitCode, null, "worker ignored stdin EOF during MCP server startup");
assert.ok(Date.now() - stopAt < 9000);
await until(async () => !(await groupAlive(group)), 5000, "slow server group still alive after stop");
await rm(root, { recursive: true, force: true });
console.log("mcp-gateway smoke ok");
