// The lsp tool against a real language server (clangd). Skips when clangd is not installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (spawnSync("clangd", ["--version"], { stdio: "ignore" }).status !== 0) { console.log("omp lsp real server (clangd): SKIPPED (clangd not installed)"); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-clangd-"));
await writeFile(join(root, "main.c"), "int add(int a, int b) { return a + b; }\nint main(void) { int x = add(1, 2); return undefined_name; }\n");
await writeFile(join(root, "Makefile"), "all:\n\tcc main.c\n");
const bin = resolve("rust/runtime/target/debug", process.platform === "win32" ? "ai-local-hub-runtime.exe" : "ai-local-hub-runtime");
const worker = spawn(bin, ["--local-only"], { env: { ...process.env, WORKSPACE_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const ready = new Promise((ok, bad) => {
  worker.stdout.on("data", chunk => { buf += chunk; for (;;) { const nl = buf.indexOf("\n"); if (nl < 0) break; const line = buf.slice(0, nl); buf = buf.slice(nl + 1); try { const e = JSON.parse(line); if (e.type === "mcp") ok(e.url); if (e.type === "fatal") bad(new Error(e.message)); } catch {} } });
  worker.once("exit", code => bad(new Error("Worker exited " + code)));
});
const client = new Client({ name: "omp-lsp-real", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(await ready)));
  const L = async args => text(await client.callTool({ name: "lsp", arguments: args }, undefined, { timeout: 120000 }));
  assert.match(await L({ action: "status" }), /^Language servers: clangd \(configured, not started\)/);
  assert.match(await L({ action: "diagnostics", file: "main.c", timeout: 60 }), /^1 error\(s\):\n# main\.c\n  2:44 \[error\] \[clang\] Use of undeclared identifier 'undefined_name'/);
  assert.match(await L({ action: "status" }), /^Language servers: clangd \(ready\)/);
  assert.match(await L({ action: "definition", file: "main.c", line: 2, symbol: "add" }), /^Found 1 definition\(s\):\n  main\.c:1:5\n    1: int add\(int a, int b\)/);
  assert.match(await L({ action: "hover", file: "main.c", line: 2, symbol: "add" }), /int add\(int a, int b\)/);
  assert.match(await L({ action: "symbols", file: "main.c" }), /^Symbols in main\.c:\n⟲ add .* @ line 1\n⟲ main .* @ line 2$/);
  console.log("omp lsp real server (clangd): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
