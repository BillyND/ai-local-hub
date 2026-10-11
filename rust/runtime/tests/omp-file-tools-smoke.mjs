// Real MCP-client test of the omp-style read / write / edit (hashline) tools.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-files-"));
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
const client = new Client({ name: "omp-file-tools", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
try {
  const url = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("start timeout " + stderr)), 15000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = (name, args) => client.callTool({ name, arguments: args });
  const tools = (await client.listTools()).tools;
  assert.match(tools.find(t => t.name === "edit").description, /Hashline patches existing files/);
  assert.deepEqual(Object.keys(tools.find(t => t.name === "edit").inputSchema.properties), ["input"]);
  assert.deepEqual(Object.keys(tools.find(t => t.name === "read").inputSchema.properties), ["path"]);

  // write returns a snapshot header; read shows the same tag and numbered rows
  const w = await call("write", { path: "src/a.txt", content: "one\ntwo\nthree\nfour\nfive\n" });
  assert.notEqual(w.isError, true);
  const tag = text(w).match(/^\[src\/a\.txt#([0-9A-F]{4})\]/)?.[1];
  assert.ok(tag, text(w));
  assert.match(text(w), /Successfully wrote 24 bytes to src\/a\.txt/);
  const r = await call("read", { path: "src/a.txt" });
  assert.equal(text(r), `[src/a.txt#${tag}]\n1:one\n2:two\n3:three\n4:four\n5:five`);

  // selectors: range (with 1 leading + 3 trailing context), tail, raw
  assert.equal(text(await call("read", { path: "src/a.txt:3-3" })), `[src/a.txt#${tag}]\n2:two\n3:three\n4:four\n5:five`);
  assert.equal(text(await call("read", { path: "src/a.txt:-2" })), `[src/a.txt#${tag}]\n4:four\n5:five`);
  assert.equal(text(await call("read", { path: "src/a.txt:raw:2-3" })), "two\nthree");
  assert.match(text(await call("read", { path: "src/a.txt:9" })), /Line 9 is beyond end of file \(5 lines total\)/);
  assert.equal((await call("read", { path: "src/a.txt:0" })).isError, true);
  assert.match(text(await call("read", { path: "missing.txt" })), /Path 'missing.txt' not found/);

  // hashline edit against the tag from read
  const e = await call("edit", { input: `[src/a.txt#${tag}]\nPUT 2.=2:\n+TWO\nPUT >5:\n+six\n` });
  assert.notEqual(e.isError, true, text(e));
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "one\nTWO\nthree\nfour\nfive\nsix\n");
  const newTag = text(e).match(/^\[src\/a\.txt#([0-9A-F]{4})\]/)?.[1];
  assert.ok(newTag && newTag !== tag, text(e));

  // stale tag, unrelated line changed: omp remaps the anchor and applies with a warning
  await writeFile(join(root, "src/a.txt"), "changed\nTWO\nthree\nfour\nfive\nsix\n");
  const recovered = await call("edit", { input: `[src/a.txt#${newTag}]\nPUT 3.=3:\n+THREE\n` });
  assert.notEqual(recovered.isError, true, text(recovered));
  assert.match(text(recovered), /Warnings:/);
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "changed\nTWO\nTHREE\nfour\nfive\nsix\n");

  // stale tag, anchored line itself changed: rejected, file untouched
  const t2 = text(await call("read", { path: "src/a.txt" })).match(/#([0-9A-F]{4})\]/)[1];
  await writeFile(join(root, "src/a.txt"), "changed\nTWO\nOTHER\nfour\nfive\nsix\n");
  const stale = await call("edit", { input: `[src/a.txt#${t2}]\nPUT 3.=3:\n+X\n` });
  assert.equal(stale.isError, true);
  assert.match(text(stale), /Edit rejected for src\/a\.txt: file changed between read and edit/);
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "changed\nTWO\nOTHER\nfour\nfive\nsix\n");

  // unknown tag is rejected as "not from this session"
  const unknown = await call("edit", { input: `[src/a.txt#0000]\nPUT 1.=1:\n+X\n` });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /not from this session|file changed/);

  // edit straight after write, without a read: observe how the engine treats write-minted tags
  const fresh = await call("write", { path: "fresh.txt", content: "a\nb\nc\n" });
  const freshTag = text(fresh).match(/#([0-9A-F]{4})\]/)[1];
  const direct = await call("edit", { input: `[fresh.txt#${freshTag}]\nPUT 2.=2:\n+B\n` });
  assert.notEqual(direct.isError, true, text(direct)); // a write-minted tag is directly editable
  assert.equal(await readFile(join(root, "fresh.txt"), "utf8"), "a\nB\nc\n");

  // CRLF is preserved by edits
  await call("write", { path: "crlf.txt", content: "a\r\nb\r\nc\r\n" });
  const rc = text(await call("read", { path: "crlf.txt" }));
  const crlfTag = rc.match(/#([0-9A-F]{4})\]/)[1];
  assert.notEqual((await call("edit", { input: `[crlf.txt#${crlfTag}]\nPUT 2.=2:\n+B\n` })).isError, true);
  assert.equal(await readFile(join(root, "crlf.txt"), "utf8"), "a\r\nB\r\nc\r\n");

  // write strips pasted hashline prefixes and refuses generated files
  const stripped = await call("write", { path: "pasted.txt", content: "1:alpha\n2:beta\n" });
  assert.equal(await readFile(join(root, "pasted.txt"), "utf8"), "alpha\nbeta\n");
  assert.match(text(stripped), /auto-stripped hashline display prefixes/);
  await writeFile(join(root, "gen.pb.go"), "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x\n");
  const gen = await call("write", { path: "gen.pb.go", content: "package y\n" });
  assert.equal(gen.isError, true);
  assert.match(text(gen), /Cannot modify auto-generated file: gen\.pb\.go/);
  assert.match(text(await call("write", { path: "run.sh", content: "#!/bin/sh\necho hi\n" })), /Made executable via chmod \+x/);
  if (process.platform !== "win32") assert.ok(((await stat(join(root, "run.sh"))).mode & 0o111) !== 0);
  assert.equal((await call("write", { path: "nocontent.txt" })).isError, true);

  // directory listing and binary refusal
  assert.match(text(await call("read", { path: "src" })), /- a\.txt/);
  await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  assert.match(text(await call("read", { path: "bin.dat" })), /Cannot read binary file 'bin\.dat'/);
  console.log("omp file tools (read/write/edit hashline): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
