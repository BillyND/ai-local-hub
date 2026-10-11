// Real MCP-client test of the omp-style ast_grep / ast_edit (+ resolve / reject) tools.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-ast-"));
const bin = resolve("rust/runtime/target/debug", process.platform === "win32" ? "ai-local-hub-runtime.exe" : "ai-local-hub-runtime");
const worker = spawn(bin, ["--local-only"], { env: { ...process.env, WORKSPACE_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
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
const client = new Client({ name: "omp-ast-tools", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
const put = async (rel, body) => { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), body); };
const file = rel => readFile(join(root, rel), "utf8");
try {
  const url = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("start timeout " + stderr)), 15000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  await put("a.ts", 'console.log("a");\nfoo(1, 2);\nfunction x() { console.log(b, c); }\n');
  await put("src/b.ts", "oldApi(1);\noldApi(a, b);\n");
  await put("src/p.py", "print('x')\n");
  await put("broken.ts", "function (\n");

  // ast_grep: single file (flat, tagged, meta captures), directory (grouped), no match, errors
  const one = text(await call("ast_grep", { pat: "console.log($$$ARGS)", path: "a.ts" }));
  assert.match(one, /^\[a\.ts#[0-9A-F]{4}\]\n\*1:console\.log\("a"\)\n  meta: ARGS=.*\n\*3:console\.log\(b, c\)\n  meta: ARGS=/, one);
  const dir = text(await call("ast_grep", { pat: "oldApi($$$A)" }));
  assert.match(dir, /^# src\/\n## b\.ts#[0-9A-F]{4}\n\*1:oldApi\(1\)\n/, dir);
  assert.match(dir, /\n\nParse issues:\n- broken\.ts: parse error \(syntax tree contains error nodes\)$/, dir);
  assert.equal(text(await call("ast_grep", { pat: "nothing($$$A)", path: "a.ts" })), "No matches found");
  const bad = await call("ast_grep", { pat: "console.log($$$A)", path: "a.ts", lang: "klingon" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /^Unsupported language 'klingon'\. Supported: astro, bash,/);
  assert.match(text(await call("ast_grep", { pat: "  " })), /`pat` must be a non-empty pattern/);
  assert.match(text(await call("ast_grep", { pat: "x", skip: -1 })), /skip must be a non-negative number/);

  // edit directly from an ast_grep tag
  const tag = one.match(/\[a\.ts#([0-9A-F]{4})\]/)[1];
  const unseen = await call("edit", { input: `[a.ts#${tag}]\nPUT 2.=2:\n+foo(3, 4);\n` }); // line 2 was never shown
  assert.equal(unseen.isError, true);
  assert.notEqual((await call("edit", { input: `[a.ts#${tag}]\nPUT 1.=1:\n+console.info("a");\n` })).isError, true);
  assert.match(await file("a.ts"), /^console\.info\("a"\);\nfoo\(1, 2\);/);

  // ast_edit stages a proposal; the file is untouched until resolve
  const staged = text(await call("ast_edit", { ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], paths: ["src"] }));
  assert.match(staged, /^Staged as a proposal — files NOT modified yet\. To apply: call `resolve` with a one-sentence reason\. To discard: call `reject`\.\n\n# src\/\n## b\.ts#[0-9A-F]{4} \(2 replacements\)\n-1:oldApi\(1\)\n\+1:newApi\(1\)\n-2:oldApi\(a, b\)\n\+2:newApi\(a, b\)$/, staged);
  assert.equal(await file("src/b.ts"), "oldApi(1);\noldApi(a, b);\n");
  const applied = text(await call("resolve", { reason: "rename" }));
  assert.match(applied, /^Applied 2 replacements in 1 file\.\n\[src\/b\.ts#[0-9A-F]{4}\]$/, applied);
  assert.equal(await file("src/b.ts"), "newApi(1);\nnewApi(a, b);\n");
  const freshTag = applied.match(/#([0-9A-F]{4})\]/)[1];
  assert.notEqual((await call("edit", { input: `[src/b.ts#${freshTag}]\nPUT 1.=1:\n+newApi(0);\n` })).isError, true);

  // reject keeps files; empty queue messages
  await call("ast_edit", { ops: [{ pat: "print($$$A)", out: "logger.info($$$A)" }], paths: ["src/p.py"] });
  assert.equal(text(await call("reject", { reason: "no" })), "Discarded: AST Edit: 1 replacement in 1 file. Reason: no");
  assert.equal(await file("src/p.py"), "print('x')\n");
  assert.equal(text(await call("reject", { reason: "x" })), "Nothing to reject; no pending action remains.");
  const none = await call("resolve", {});
  assert.equal(none.isError, true);
  assert.match(text(none), /^No pending action to apply/);

  // stale preview: the file changes between staging and resolve
  await put("stale.ts", "oldApi(1);\noldApi(2);\n");
  await call("ast_edit", { ops: [{ pat: "oldApi($$$A)", out: "fresh($$$A)" }], paths: ["stale.ts"] });
  await put("stale.ts", "oldApi(1);\n");
  const stale = await call("resolve", {});
  assert.equal(stale.isError, true);
  assert.match(text(stale), /^Preview is stale \/ no longer matches; only 1 of 2 replacements were applied in 1 of 1 files\./);

  // delete with empty out, mixed-language paths, validation
  await put("del.ts", "keep();\nconsole.log(1);\nconsole.log(2);\n");
  await call("ast_edit", { ops: [{ pat: "console.log($$$A)", out: "" }], paths: ["del.ts"] });
  assert.match(text(await call("resolve", {})), /^Applied 2 replacements in 1 file\./);
  assert.doesNotMatch(await file("del.ts"), /console\.log/);
  assert.match(text(await call("ast_edit", { ops: [{ pat: "x", out: "y" }, { pat: "x", out: "z" }], paths: ["a.ts"] })), /Duplicate rewrite pattern: x/);
  assert.match(text(await call("ast_edit", { ops: [{ pat: "", out: "y" }], paths: ["a.ts"] })), /`ops\[0\]\.pat` must be a non-empty pattern/);
  assert.match(text(await call("ast_edit", { ops: [{ pat: "zzz($$$A)", out: "y" }], paths: ["a.ts"] })), /^No replacements made/);
  console.log("omp ast tools (ast_grep/ast_edit/resolve/reject): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
