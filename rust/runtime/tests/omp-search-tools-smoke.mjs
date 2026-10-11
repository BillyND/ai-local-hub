// Real MCP-client test of the omp-style grep / glob tools.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-search-"));
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
const client = new Client({ name: "omp-search-tools", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
const put = async (rel, body) => { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), body); };
try {
  const url = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("start timeout " + stderr)), 15000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = (name, args) => client.callTool({ name, arguments: args });
  await put("a.ts", "alpha\nneedle one\nbeta\n");
  await put("src/b.ts", "needle two\n");
  await put("src/deep/c.ts", "x\nneedle three\ny\nz\nw\nv\n");
  await put("README.md", "no hits here\n");
  await put(".gitignore", "ignored.ts\n");
  await put("ignored.ts", "needle ignored\n");
  await put("node_modules/m.ts", "needle module\n");
  await put(".hidden/h.ts", "needle hidden\n");
  const tags = {};
  const tagOf = (out, name) => out.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#([0-9A-F]{4})`))?.[1];

  // single file: header, match marker, 1 before + 3 after context
  const single = text(await call("grep", { pattern: "needle", path: "a.ts" }));
  assert.match(single, /^\[a\.ts#[0-9A-F]{4}\]\n 1:alpha\n\*2:needle one\n 3:beta$/, single);

  // directory scope: grouped, hidden included, gitignore + node_modules + .git excluded
  const dir = text(await call("grep", { pattern: "needle" }));
  assert.match(dir, /^# \.hidden\/\n## h\.ts#[0-9A-F]{4}\n\*1:needle hidden/m, dir);
  assert.match(dir, /^# a\.ts#[0-9A-F]{4}\n 1:alpha\n\*2:needle one\n 3:beta\n/m, dir);
  assert.ok(dir.includes("a.ts#") && dir.includes("b.ts#") && dir.includes("c.ts#") && dir.includes("h.ts#"), dir);
  assert.ok(!dir.includes("ignored.ts") && !dir.includes("node_modules") && !dir.includes("m.ts"), dir);
  assert.match(dir, /\*2:needle three/);
  assert.match(dir, /\*1:needle two/);

  // bare glob recurses; prefixed glob does not
  const bare = text(await call("grep", { pattern: "needle", path: "*.ts" }));
  assert.ok(bare.includes("c.ts#") && bare.includes("a.ts#"), bare);
  const direct = text(await call("grep", { pattern: "needle", path: "src/*.ts" }));
  assert.ok(direct.includes("b.ts#") && !direct.includes("c.ts#"), direct);

  // case, no match, errors
  assert.equal(text(await call("grep", { pattern: "NEEDLE", path: "a.ts" })), "No matches found");
  assert.match(text(await call("grep", { pattern: "NEEDLE", path: "a.ts", case: false })), /\*2:needle one/);
  assert.equal((await call("grep", { pattern: "  " })).isError, true);
  assert.match(text(await call("grep", { pattern: "x", path: "nope" })), /Path not found: nope/);
  assert.match(text(await call("grep", { pattern: "x", skip: -1 })), /Skip must be a non-negative number/);

  // multi-path list and missing-path note
  const multi = text(await call("grep", { pattern: "needle", path: "a.ts;src/b.ts" }));
  assert.ok(multi.includes("a.ts#") && multi.includes("b.ts#"), multi);
  const withMissing = text(await call("grep", { pattern: "needle", path: "a.ts;nope" }));
  assert.match(withMissing, /Skipped missing paths: nope/);

  // line-range selector keeps only in-range matches
  const ranged = text(await call("grep", { pattern: "needle", path: "src/deep/c.ts:1-1" }));
  assert.equal(ranged, "No matches found");

  // edit directly from a grep tag
  const forEdit = text(await call("grep", { pattern: "needle one", path: "a.ts" }));
  const aTag = forEdit.match(/\[a\.ts#([0-9A-F]{4})\]/)[1];
  const edited = await call("edit", { input: `[a.ts#${aTag}]\nPUT 2.=2:\n+needle ONE\n` });
  assert.notEqual(edited.isError, true, text(edited));
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "alpha\nneedle ONE\nbeta\n");

  // pagination: 25 matching files -> 20 per page
  for (let i = 0; i < 25; i++) await put(`many/f${String(i).padStart(2, "0")}.txt`, "pageme\n");
  const p1 = text(await call("grep", { pattern: "pageme", path: "many" }));
  assert.match(p1, /Showing files 1-20 of 25\. Use skip=20 for the next page, or narrow paths\/pattern\./);
  const p2 = text(await call("grep", { pattern: "pageme", path: "many", skip: 20 }));
  assert.ok(p2.includes("f24.txt") && !p2.includes("Showing files"), p2);
  assert.match(text(await call("grep", { pattern: "pageme", path: "many", skip: 99 })), /No more results \(25 files total; skip=99 is past the end\)/);

  // long line is windowed and noted
  await put("long.txt", "a".repeat(1500) + "FINDME" + "b".repeat(1500) + "\n");
  const longOut = text(await call("grep", { pattern: "FINDME", path: "long.txt" }));
  assert.match(longOut, /FINDME.*\[col 1501\]/);
  assert.match(longOut, /\[Some lines truncated to 512 bytes\]$/);

  // glob
  await utimes(join(root, "src/deep/c.ts"), new Date(), new Date()); // newest
  const g = text(await call("glob", { path: "**/*.ts" }));
  assert.match(g, /# src\/\nb\.ts\n## deep\/\nc\.ts/);
  assert.ok(g.includes("a.ts") && g.includes("b.ts") && !g.includes("ignored.ts") && !g.includes("node_modules"), g);
  assert.equal(text(await call("glob", { path: "*.nothing" })), "No files found matching pattern");
  assert.match(text(await call("glob", { path: "*.ts", limit: 2 })), /\[2 results limit reached\. Use limit=4 for more\]$/);
  assert.match(text(await call("glob", { path: "/" })), /Searching from root directory '\/' is not allowed/);
  assert.match(text(await call("glob", { path: "src" })), /# deep\/\nc\.ts|deep\/\n/);
  assert.match(text(await call("glob", { path: "nope/**/*.ts" })), /Path not found: nope/);
  const ign = text(await call("glob", { path: "*.ts", gitignore: false }));
  assert.ok(ign.includes("ignored.ts"), ign);
  assert.match(text(await call("glob", { path: "*.ts;nope" })), /Skipped missing paths: nope/);
  console.log("omp search tools (grep/glob): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
