// Real MCP-client test of the omp-style bash / wait tools (system bash backend).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-bash-"));
const bin = resolve("rust/runtime/target/debug", process.platform === "win32" ? "ai-local-hub-runtime.exe" : "ai-local-hub-runtime");
const worker = spawn(bin, ["--local-only"], { env: { ...process.env, WORKSPACE_ROOT: root, AI_LOCAL_HUB_AUTO_BG_SECS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", stderr = "";
worker.stderr.on("data", c => stderr += c);
const ready = new Promise((ok, bad) => {
  worker.stdout.on("data", chunk => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n"); if (nl < 0) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "mcp") ok(e.url);
      if (e.type === "fatal") bad(new Error(e.message));
    }
  });
  worker.once("exit", code => bad(new Error("Worker exited " + code + " " + stderr)));
});
const client = new Client({ name: "omp-bash-tools", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const url = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("start timeout " + stderr)), 15000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const props = n => Object.keys(tools.find(t => t.name === n).inputSchema.properties).sort();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(props("bash"), ["async", "command", "cwd", "pty", "timeout"]);
  for (const n of ["wait", "kill_job"]) assert.ok(tools.some(t => t.name === n), n);

  // basic result shape: merged output, wall time, no exit line on success
  const hello = await call("bash", { command: "echo hello; echo oops >&2" });
  assert.notEqual(hello.isError, true);
  assert.match(text(hello), /^hello\noops\n\nWall time: \d+\.\d\d seconds$/);
  assert.equal(text(await call("bash", { command: "true" })).split("\n")[0], "(no output)");
  const fail = await call("bash", { command: "echo bye; exit 3" });
  assert.equal(fail.isError, true);
  assert.match(text(fail), /^bye\n\nWall time: [\d.]+ seconds\n\nCommand exited with code 3$/);

  // cwd, leading-cd lift, bad cwd, non-interactive env
  await mkdir(join(root, "sub dir"));
  assert.match(text(await call("bash", { command: "pwd", cwd: "sub dir" })), /sub dir\n/);
  assert.match(text(await call("bash", { command: "cd 'sub dir' && pwd" })), /sub dir\n/);
  assert.match(text(await call("bash", { command: "pwd", cwd: "nope" })), /^Working directory does not exist: /);
  assert.match(text(await call("bash", { command: 'printf "$PAGER|$CI"' })), /^cat\|true\n/);

  // a deadline shorter than the auto-background wait backgrounds at once; the job then fails with the timeout text
  const timedStart = text(await call("bash", { command: "echo start; sleep 5", timeout: 0.2 }));
  assert.match(timedStart, /^Timeout clamped to 1s \(requested 0\.2s; allowed range 1-3600s\)\.\n\nBackgrounded as job bg_1 \(killed once it has run 1s in total/);
  const timedWait = text(await call("wait"));
  assert.match(timedWait, /### bg_1 \[bash\] — failed\nLabel: echo start; sleep 5\nDelivery: not auto-delivered; recovered by this snapshot\.\nError: \[Command timed out after 1 seconds\]\nstart\n/);

  // truncation: head/tail, notice, full output readable as artifact://
  const big = await call("bash", { command: "seq 1 20000" });
  const bigText = text(big);
  assert.match(bigText, /^1\n2\n3\n/);
  assert.match(bigText, /\[…\d+ln elided…\]/);
  assert.match(bigText, /\n20000\n\nWall time/);
  assert.match(bigText, /\[Showing lines 1-\d+ and \d+-20000 of 20000; [\d,]+ middle lines \([\d.]+KB\) elided\. Read artifact:\/\/1 for full output\]$/);
  assert.equal(text(await call("read", { path: "artifact://1:raw:10000-10002" })), "10000\n10001\n10002");
  const longLine = text(await call("bash", { command: "head -c 3000 /dev/zero | tr '\\0' x; echo" }));
  assert.match(longLine, /\[Some lines truncated to 768 bytes\. Use artifact:\/\/2:raw:1-1 to read line 1 whole\]$/);

  // async job + wait
  const started = text(await call("bash", { command: "sleep 1; echo done-async", async: true }));
  assert.match(started, /^Backgrounded as job bg_2 \(killed once it has run 300s in total; `timeout: 0` disables the deadline\); /);
  assert.match(started, /Do NOT poll for it/);
  const waited = text(await call("wait"));
  assert.match(waited, /^## Completed \(1\)\n\n### bg_2 \[bash\] — completed\nLabel: sleep 1; echo done-async\nDelivery: not auto-delivered; recovered by this snapshot\.\n```\ndone-async\n\nWall time: [\d.]+ seconds\n```$/);
  const nothing = await call("wait");
  assert.equal(nothing.isError, true);
  assert.match(text(nothing), /^Nothing to wait for: no background job or service you started is running\./);

  // piggyback delivery on the next tool result
  await call("bash", { command: "echo piggy", async: true });
  await sleep(700);
  const next = text(await call("glob", { path: "*.nothing" }));
  assert.match(next, /^No files found matching pattern\n<system-notice>\nBackground job bg_3 has completed\. Resume your work using the result below\.\n\npiggy\n/);

  // auto-background after the threshold (1s here), then kill it
  const auto = text(await call("bash", { command: "echo early; sleep 30" }));
  assert.match(auto, /^early\n\nBackgrounded as job bg_4 /);
  assert.equal(text(await call("kill_job", { id: "bg_4" })), "Cancelled background job bg_4.");
  assert.equal(text(await call("kill_job", { id: "bg_4" })), "Background job bg_4 is already cancelled.");
  assert.equal(text(await call("kill_job", { id: "bg_99" })), "Background job not found: bg_99");

  // pty request degrades with a notice
  assert.match(text(await call("bash", { command: "echo t", pty: true })), /pty requested but unavailable in this environment; ran without a terminal/);
  console.log("omp bash tools (bash/wait/kill_job): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
