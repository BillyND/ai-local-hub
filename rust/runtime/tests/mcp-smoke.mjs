import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(join(tmpdir(), "ai-local-hub-rust-"));
const bin = process.argv[2] || fileURLToPath(new URL("../target/debug/"+(process.platform==="win32"?"ai-local-hub-runtime.exe":"ai-local-hub-runtime"),import.meta.url));
const worker = spawn(bin, ["--local-only"], {
    env: { ...process.env, WORKSPACE_ROOT: root }, stdio: ["pipe", "pipe", "pipe"]
});
let stdout = "", stderr = "";
worker.stderr.on("data", c => stderr += c);
let readyResolve, readyReject;
const ready = new Promise((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
worker.stdout.on("data", data => {
  stdout += data;
  for (;;) {
    const idx=stdout.indexOf("\n");
    if(idx<0)break;
    const line=stdout.slice(0,idx);stdout=stdout.slice(idx+1);
    const event=JSON.parse(line);
    if(event.type==="mcp")readyResolve(event.url);
    if(event.type==="fatal")readyReject(new Error(event.message));
  }
});
worker.on("exit",(code)=>readyReject(new Error("Worker exited early: "+code+" "+stderr)));
const client = new Client({name:"rust-migration-smoke",version:"0.1.0"});
try {
  const url=await Promise.race([ready,new Promise((_,r)=>setTimeout(()=>r(new Error("Timed out waiting for Rust worker: "+stderr)),10000))]);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools = (await client.listTools()).tools.map(t=>t.name);
  for(const name of ["read","bash","edit","write","grep","find","ls"])assert.ok(tools.includes(name),name);
  const call = (name,args) => client.callTool({name,arguments:args});
  const text = r=>r.content.find(c=>c.type==="text")?.text || "";
  assert.notEqual((await call("write",{path:"sample.txt",content:"one\nneedle\n"})).isError,true);
  assert.equal(await readFile(join(root,"sample.txt"),"utf8"),"one\nneedle\n");
  assert.match(text(await call("read",{path:"sample.txt",offset:2,limit:1})),/needle/);
  assert.notEqual((await call("edit",{path:"sample.txt",edits:[{oldText:"needle",newText:"changed"}]})).isError,true);
  assert.match(await readFile(join(root,"sample.txt"),"utf8"),/changed/);
  assert.match(text(await call("grep",{pattern:"changed"})),/sample.txt/);
  assert.match(text(await call("find",{pattern:"*.txt"})),/sample.txt/);
  assert.match(text(await call("ls",{})),/sample.txt/);
  const shell=await call("bash",{command:"printf out; printf err >&2; exit 7"});
  assert.equal(shell.isError,true);
  assert.match(text(shell),/out/);
  assert.match(text(shell),/err/);
  assert.equal(shell.structuredContent.exit_code,7);
  const img=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==","base64");
  await writeFile(join(root,"pixel.png"),img);
  assert.equal((await call("read",{path:"pixel.png"})).content[0].type,"image");
  assert.equal((await call("read",{path:"no-file"})).isError,true);
  // MCP rejects an unnegotiated GET (406 is the expected protocol response).
  const bad=await fetch(url);assert.equal(bad.status,406);
  console.log("Rust MCP integration: PASS",tools.join(","),url);
} finally {
  await client.close().catch(()=>{});
  worker.stdin.end();
  await Promise.race([new Promise(resolve=>worker.once("exit",resolve)),new Promise(resolve=>setTimeout(()=>{worker.kill("SIGKILL");resolve();},5000))]);
  await rm(root,{recursive:true,force:true});
}
