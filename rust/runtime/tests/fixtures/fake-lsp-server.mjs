// Scriptable fake language server for the `lsp` tool tests: `.fk` files, `def NAME` declarations.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const docs = new Map(); // uri -> {text, version}
const log = [];
let root = process.cwd();
let buf = Buffer.alloc(0);

function send(msg) { const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg })); process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`); process.stdout.write(body); }
const reply = (id, result) => send({ id, result });
const wordAt = (text, line, ch) => { const l = text.split("\n")[line] ?? ""; let s = ch, e = ch; while (s > 0 && /\w/.test(l[s - 1])) s--; while (e < l.length && /\w/.test(l[e])) e++; return l.slice(s, e); };
const occurrences = (text, word) => { const out = []; text.split("\n").forEach((l, i) => { for (const m of l.matchAll(new RegExp(`\\b${word}\\b`, "g"))) out.push({ line: i, from: m.index, to: m.index + word.length }); }); return out; };
const range = (o) => ({ start: { line: o.line, character: o.from }, end: { line: o.line, character: o.to } });
const files = () => readdirSync(root).filter(f => f.endsWith(".fk")).map(f => join(root, f));
const publish = (uri) => {
  const d = docs.get(uri); if (!d) return;
  const diagnostics = [];
  d.text.split("\n").forEach((l, i) => { if (l.includes("TODO")) diagnostics.push({ range: range({ line: i, from: l.indexOf("TODO"), to: l.indexOf("TODO") + 4 }), severity: 2, source: "fake", code: "W1", message: "todo left behind" }); if (l.includes("ERR")) diagnostics.push({ range: range({ line: i, from: l.indexOf("ERR"), to: l.indexOf("ERR") + 3 }), severity: 1, source: "fake", message: "bad token\nfor further information visit https://example.com" }); });
  send({ method: "textDocument/publishDiagnostics", params: { uri, version: d.version, diagnostics } });
};

function handle(m) {
  const { id, method, params } = m;
  log.push(method);
  switch (method) {
    case "initialize": root = fileURLToPath(params.rootUri); return reply(id, { capabilities: { textDocumentSync: { openClose: true, change: 1, save: { includeText: false } }, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, renameProvider: true, codeActionProvider: true } });
    case "initialized": send({ method: "window/workDoneProgress/create", id: 900, params: { token: "load" } }); send({ method: "$/progress", params: { token: "load", value: { kind: "begin", title: "indexing" } } }); setTimeout(() => send({ method: "$/progress", params: { token: "load", value: { kind: "end" } } }), 50); return;
    case "textDocument/didOpen": docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version }); log.push(`open:v${params.textDocument.version}`); return publish(params.textDocument.uri);
    case "textDocument/didChange": docs.set(params.textDocument.uri, { text: params.contentChanges[0].text, version: params.textDocument.version }); log.push(`change:v${params.textDocument.version}`); return publish(params.textDocument.uri);
    case "textDocument/didSave": return publish(params.textDocument.uri);
    case "textDocument/didClose": docs.delete(params.textDocument.uri); log.push("close"); return;
    case "textDocument/hover": { const d = docs.get(params.textDocument.uri); const w = wordAt(d.text, params.position.line, params.position.character); return reply(id, w ? { contents: { kind: "markdown", value: `hover:${w}` } } : null); }
    case "textDocument/definition": { const d = docs.get(params.textDocument.uri); const w = wordAt(d.text, params.position.line, params.position.character); const hit = d.text.split("\n").findIndex(l => new RegExp(`^def ${w}\\b`).test(l)); return reply(id, hit < 0 ? null : [{ uri: params.textDocument.uri, range: range({ line: hit, from: 4, to: 4 + w.length }) }]); }
    case "textDocument/references": { const d = docs.get(params.textDocument.uri); const w = wordAt(d.text, params.position.line, params.position.character); return reply(id, occurrences(d.text, w).map(o => ({ uri: params.textDocument.uri, range: range(o) }))); }
    case "textDocument/documentSymbol": { const d = docs.get(params.textDocument.uri); const syms = []; d.text.split("\n").forEach((l, i) => { const mm = /^def (\w+)/.exec(l); if (mm) syms.push({ name: mm[1], kind: 12, detail: "()", range: range({ line: i, from: 0, to: l.length }), selectionRange: range({ line: i, from: 4, to: 4 + mm[1].length }) }); }); return reply(id, syms); }
    case "workspace/symbol": { const out = []; for (const f of files()) readFileSync(f, "utf8").split("\n").forEach((l, i) => { const mm = /^def (\w+)/.exec(l); if (mm && mm[1].toLowerCase().includes(params.query.toLowerCase())) out.push({ name: mm[1], kind: 12, containerName: "mod", location: { uri: pathToFileURL(f).href, range: range({ line: i, from: 4, to: 4 + mm[1].length }) } }); }); return reply(id, out); }
    case "textDocument/rename": { const d = docs.get(params.textDocument.uri); const w = wordAt(d.text, params.position.line, params.position.character); return reply(id, { changes: { [params.textDocument.uri]: occurrences(d.text, w).map(o => ({ range: range(o), newText: params.newName })) } }); }
    case "textDocument/codeAction": { const uri = params.textDocument.uri; const d = docs.get(uri); const line = params.range.start.line; return reply(id, [{ title: "Remove TODO", kind: "quickfix", isPreferred: true, edit: { changes: { [uri]: [{ range: range({ line, from: 0, to: (d.text.split("\n")[line] ?? "").length }), newText: "" }] } } }, { title: "Run noop", kind: "refactor", command: { title: "Run noop", command: "fake.noop", arguments: [1] } }, { title: "Locked", kind: "refactor", disabled: { reason: "not now" } }]); }
    case "workspace/executeCommand": log.push(`command:${params.command}`); return reply(id, null);
    case "workspace/willRenameFiles": { const changes = {}; for (const { oldUri, newUri } of params.files) { const oldBase = fileURLToPath(oldUri).split("/").pop().replace(/\.fk$/, ""); const newBase = fileURLToPath(newUri).split("/").pop().replace(/\.fk$/, ""); for (const f of files()) { const lines = readFileSync(f, "utf8").split("\n"); lines.forEach((l, i) => { const at = l.indexOf(`import ${oldBase}`); if (at >= 0) (changes[pathToFileURL(f).href] ??= []).push({ range: range({ line: i, from: at + 7, to: at + 7 + oldBase.length }), newText: newBase }); }); } } return reply(id, { changes }); }
    case "workspace/didRenameFiles": log.push("didRename"); return;
    case "workspace/didChangeWatchedFiles": log.push("watched"); return;
    case "fake/log": return reply(id, log.slice());
    case "fake/boom": return send({ id, error: { code: -32000, message: "boom" } });
    case "shutdown": return reply(id, null);
    case "exit": process.exit(0);
    default: if (id !== undefined && method) return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

process.stdin.on("data", chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const body = JSON.parse(buf.slice(end + 4, end + 4 + len).toString()); buf = buf.slice(end + 4 + len);
    if (body.method || body.id !== undefined) { if (body.method) handle(body); }
  }
});
