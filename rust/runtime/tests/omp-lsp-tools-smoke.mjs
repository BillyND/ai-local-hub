// Real MCP-client test of the omp-style lsp tool against a scriptable fake language server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-omp-lsp-"));
const fake = resolve("rust/runtime/tests/fixtures/fake-lsp-server.mjs");
await writeFile(join(root, "lsp.json"), JSON.stringify({ servers: { fake: { command: "node", args: [fake], fileTypes: [".fk"], rootMarkers: ["lsp.json"] } } }));
await writeFile(join(root, "main.fk"), "def greet()\ncall greet and greet again TODO\nERR token\nimport util\n");
await writeFile(join(root, "util.fk"), "def helper()\n");
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
const client = new Client({ name: "omp-lsp-tools", version: "1.0" });
const text = r => r.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
const exists = p => access(join(root, p)).then(() => true, () => false);
try {
  const url = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("start timeout " + stderr)), 15000))]);
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  const lsp = async args => client.callTool({ name: "lsp", arguments: args });
  const L = async args => text(await lsp(args));
  assert.ok((await client.listTools()).tools.some(t => t.name === "lsp"));

  // status before and after the server starts
  assert.match(await L({ action: "status" }), /^Language servers: fake \(configured, not started\)\n  note: /);
  // diagnostics: version-echoed publish, noise stripped, errors before warnings, grouped per file
  assert.equal(await L({ action: "diagnostics", file: "main.fk" }), "1 error(s), 1 warning(s):\n# main.fk\n  3:1 [error] [fake] bad token\n  2:28 [warning] [fake] todo left behind (W1)");
  assert.match(await L({ action: "status" }), /^Language servers: fake \(ready\)/);

  // navigation
  assert.equal(await L({ action: "definition", file: "main.fk", line: 2, symbol: "greet#2" }), "Found 1 definition(s):\n  main.fk:1:5\n    1: def greet()\n    2: call greet and greet again TODO");
  const noSymbol = await lsp({ action: "definition", file: "main.fk", line: 2 });
  assert.equal(noSymbol.isError, true);
  assert.match(text(noSymbol), /^symbol is required for project-aware definition; pass symbol=<name>/);
  assert.match(await L({ action: "definition", file: "main.fk", line: 2, symbol: "nope" }), /^LSP error: Symbol "nope" not found on line 2/);
  const refs = await L({ action: "references", file: "main.fk", line: 1, symbol: "greet" });
  assert.match(refs, /^Found 3 reference\(s\):\n  main\.fk:1:5\n    1: def greet\(\)/);
  assert.equal(await L({ action: "hover", file: "main.fk", line: 1, symbol: "greet" }), "hover:greet");
  assert.equal(await L({ action: "symbols", file: "main.fk" }), "Symbols in main.fk:\n⟲ greet () @ line 1");
  assert.equal(await L({ action: "symbols", file: "*", query: "hel" }), 'Found 1 symbol(s) matching "hel":\n  ⟲ helper (mod) @ util.fk:1:5');
  assert.equal(await L({ action: "symbols", file: "*", query: "zzz" }), 'No symbols matching "zzz"');
  assert.match(await L({ action: "symbols", file: "*" }), /^Error: query parameter required for workspace symbol search/);

  // rename: preview, then apply; the server sees the change and navigation keeps working
  assert.equal(await L({ action: "rename", file: "main.fk", line: 1, symbol: "greet", new_name: "hello", apply: false }), "Rename preview:\n  main.fk: 3 edits");
  assert.equal(await readFile(join(root, "main.fk"), "utf8"), "def greet()\ncall greet and greet again TODO\nERR token\nimport util\n");
  assert.equal(await L({ action: "rename", file: "main.fk", line: 1, symbol: "greet", new_name: "hello" }), "Applied rename:\n  Applied 3 edits to main.fk");
  assert.equal(await readFile(join(root, "main.fk"), "utf8"), "def hello()\ncall hello and hello again TODO\nERR token\nimport util\n");
  assert.match(await L({ action: "definition", file: "main.fk", line: 2, symbol: "hello#1" }), /^Found 1 definition\(s\):\n  main\.fk:1:5\n    1: def hello\(\)/);
  assert.match(await L({ action: "rename", file: "main.fk", line: 1, symbol: "hello" }), /^Error: new_name parameter required for rename/);

  // code actions: list, apply by title, apply a command, no match
  assert.equal(await L({ action: "code_actions", file: "main.fk", line: 2, symbol: "call" }), "3 code action(s):\n  0: [quickfix] Remove TODO (preferred)\n  1: [refactor] Run noop\n  2: [refactor] Locked (disabled: not now)");
  assert.equal(await L({ action: "code_actions", file: "main.fk", line: 2, symbol: "call", apply: true, query: "noop" }), 'Applied "Run noop":\n  Executed command(s):\n    fake.noop');
  assert.match(await L({ action: "code_actions", file: "main.fk", line: 2, symbol: "call", apply: true, query: "zzz" }), /^No code action matches "zzz"\. Available actions:\n  0: \[quickfix\] Remove TODO/);
  assert.equal(await L({ action: "code_actions", file: "main.fk", line: 2, symbol: "call", apply: true, query: "0" }), 'Applied "Remove TODO":\n  Workspace edit:\n    Applied 1 edit to main.fk');
  assert.equal(await readFile(join(root, "main.fk"), "utf8"), "def hello()\n\nERR token\nimport util\n");

  // rename_file: validation errors, preview, apply (server rewrites the import, file moves)
  assert.equal(await L({ action: "rename_file", file: "util.fk", new_name: "util.fk" }), "Error: source and destination paths are identical");
  assert.equal(await L({ action: "rename_file", file: "gone.fk", new_name: "x.fk" }), "Error: source path does not exist: gone.fk");
  assert.equal(await L({ action: "rename_file", file: "util.fk", new_name: "main.fk" }), "Error: destination already exists: main.fk");
  assert.match(await L({ action: "rename_file", file: "util.fk" }), /^Error: rename_file requires both/);
  assert.equal(await L({ action: "rename_file", file: "util.fk", new_name: "tools.fk", apply: false }), "Rename preview: util.fk → tools.fk\n  fake:\n    main.fk: 1 edit");
  assert.equal(await exists("util.fk"), true);
  assert.equal(await L({ action: "rename_file", file: "util.fk", new_name: "tools.fk" }), "Renamed util.fk → tools.fk\n  fake: applied 1 edit(s) to main.fk\n  Renamed util.fk → tools.fk");
  assert.equal(await exists("util.fk"), false);
  assert.equal(await exists("tools.fk"), true);
  assert.equal(await readFile(join(root, "main.fk"), "utf8"), "def hello()\n\nERR token\nimport tools\n");

  // raw request, errors, capabilities, reload
  const log = await L({ action: "request", query: "fake/log" });
  assert.match(log, /^fake ← fake\/log:\n\[/);
  for (const m of ["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave", "workspace/willRenameFiles", "workspace/didRenameFiles", "workspace/didChangeWatchedFiles", "command:fake.noop"]) assert.ok(log.includes(`"${m}"`), m);
  assert.equal(await L({ action: "request", query: "fake/boom" }), "LSP error from fake on fake/boom: LSP error -32000: boom\n  params: {}");
  assert.match(await L({ action: "request", query: "fake/log", payload: "{nope" }), /^Error: invalid JSON in payload: /);
  assert.match(await L({ action: "request" }), /^Error: action=request requires `query`/);
  assert.match(await L({ action: "capabilities" }), /^fake:\n  capabilities: \{\n    "textDocumentSync"/);
  assert.equal(await L({ action: "reload", file: "main.fk" }), "Reloaded fake");
  assert.equal(await L({ action: "reload", file: "*" }), "Reloaded fake");

  // diagnostics: glob, no server, workspace checker, missing file arg
  assert.equal(await L({ action: "diagnostics", file: "*.fk" }), "✘ main.fk: 1 error(s)\n# main.fk\n  3:1 [error] [fake] bad token\n✔ tools.fk: no issues");
  assert.equal(await L({ action: "diagnostics", file: "tools.fk" }), "OK");
  assert.equal(await L({ action: "diagnostics", file: "README.md" }), "✘ README.md: No language server found");
  assert.equal(await L({ action: "diagnostics", file: "*.zzz" }), "No files matched pattern: *.zzz");
  assert.match(await L({ action: "diagnostics", file: "*" }), /^Workspace diagnostics \(Unknown project type\):\nCannot detect project type\./);
  assert.match(await L({ action: "diagnostics" }), /^Error: file parameter required\./);
  assert.equal(await L({ action: "hover" }), "Error: file parameter required. Use `*` for workspace scope where supported.");
  assert.equal(await L({ action: "hover", file: "README.md", line: 1 }), "No language server found for this action");
  assert.equal(await L({ action: "bogus" }), "Unknown action: bogus");
  // a concurrent session reuses the running server instead of starting (and indexing with) a second one
  const servers = () => spawnSync("pgrep", ["-f", fake], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
  assert.equal(servers(), 1, "one server before the second session");
  const other = new Client({ name: "omp-lsp-tools-second", version: "1.0" });
  const otherTransport = new StreamableHTTPClientTransport(new URL(url));
  await other.connect(otherTransport);
  assert.equal(text(await other.callTool({ name: "lsp", arguments: { action: "diagnostics", file: "tools.fk" } })), "OK");
  assert.equal(servers(), 1, "the second session shares the server");
  await otherTransport.terminateSession();
  await other.close();
  await new Promise(r => setTimeout(r, 500));
  assert.equal(servers(), 1, "the server outlives a session while another one is open");
  // ending the last MCP session stops the language server
  await transport.terminateSession();
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { await new Promise(r => setTimeout(r, 200)); alive = spawnSync("pgrep", ["-f", fake]).status === 0; }
  assert.equal(alive, false, "language server must exit when the session ends");
  console.log("omp lsp tool (fake language server): PASS");
} finally {
  await client.close().catch(() => {});
  worker.stdin.end();
  await Promise.race([new Promise(r => worker.once("exit", r)), new Promise(r => setTimeout(() => { worker.kill("SIGKILL"); r(); }, 5000))]);
  await rm(root, { recursive: true, force: true });
}
