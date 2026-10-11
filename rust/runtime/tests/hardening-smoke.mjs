import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root=await mkdtemp(join(tmpdir(),"ai-local-hub-hardening-"));
const bin=resolve("rust/runtime/target/debug",process.platform==="win32"?"ai-local-hub-runtime.exe":"ai-local-hub-runtime");
const worker=spawn(bin,["--local-only"],{
  env:{...process.env,WORKSPACE_ROOT:root,PATH:process.platform==="darwin"?"/usr/bin:/bin:/usr/sbin:/sbin":process.env.PATH},
  stdio:["pipe","pipe","pipe"]
});
let buf="",stderr="";
worker.stderr.on("data",c=>stderr+=c);
const ready=new Promise((resolveReady,rejectReady)=>{
  worker.stdout.on("data",chunk=>{
    buf+=chunk;
    for(;;){
      const nl=buf.indexOf("\n");if(nl<0)break;
      const line=buf.slice(0,nl);buf=buf.slice(nl+1);
      let event;try{event=JSON.parse(line)}catch{continue}
      if(event.type==="mcp")resolveReady(event.url);
      if(event.type==="fatal")rejectReady(new Error(event.message));
    }
  });
  worker.once("error",rejectReady);
  worker.once("exit",code=>rejectReady(new Error("Worker exited "+code+" "+stderr)));
});
const client=new Client({name:"hardening-smoke",version:"1.0"});
const asText=r=>r.content?.filter(c=>c.type==="text").map(c=>c.text).join("\n")||"";
try{
  const url=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Worker start timeout "+stderr)),12000))]);
  const base=new URL(url).origin;
  assert.equal((await fetch(base+"/healthz")).status,200);
  const probe=(headers)=>new Promise((resolveProbe,rejectProbe)=>{
    http.get(base+"/healthz",{headers},res=>{res.resume();res.on("end",()=>resolveProbe(res.statusCode));}).on("error",rejectProbe);
  });
  assert.equal(await probe({Host:"127.0.0.1:bad"}),403);
  assert.equal(await probe({Origin:"https://example.com"}),403);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call=(name,args)=>client.callTool({name,arguments:args});
  const visible=await call("bash",{command:"printf 'VISIBLE_STDOUT'; printf 'VISIBLE_STDERR' >&2"});
  assert.notEqual(visible.isError,true);
  assert.match(asText(visible),/VISIBLE_STDOUT/);
  assert.match(visible.structuredContent.output,/VISIBLE_STDOUT/);
  assert.match(visible.structuredContent.output,/VISIBLE_STDERR/);
  assert.equal(visible.structuredContent.exit_code,0);
  assert.equal(visible.structuredContent.truncated,false);
  assert.equal(visible.structuredContent.timed_out,false);
  const failed=await call("bash",{command:"printf 'failed command'; exit 17"});
  assert.equal(failed.isError,true);
  assert.equal(failed.structuredContent.exit_code,17);
  assert.match(failed.structuredContent.output,/failed command/);
  if(process.platform!=="win32"){
    const tooMuch=await call("bash",{command:"yes x | head -c 200000"});
    assert.notEqual(tooMuch.isError,true);
    assert.equal(tooMuch.structuredContent.truncated,true);
    assert.ok(tooMuch.structuredContent.output.length<51000);
    const timed=await call("bash",{command:"sleep 4",timeout:0.15});
    assert.equal(timed.isError,true);
    assert.equal(timed.structuredContent.timed_out,true);
    assert.equal(timed.structuredContent.exit_code,null);
  }
  const text=join(root,"small.txt");
  await writeFile(text,"first\nsecond\n");
  assert.match(asText(await call("read",{path:"small.txt",offset:2,limit:1})),/second/);
  assert.equal((await call("read",{path:"small.txt",offset:0})).isError,true);
  const edit=await call("edit",{path:"small.txt",edits:[{oldText:"second",newText:"changed"}]});
  assert.notEqual(edit.isError,true);
  assert.equal(await readFile(text,"utf8"),"first\nchanged\n");
  assert.equal((await call("edit",{path:"small.txt",edits:[{oldText:"missing",newText:"no"}]})).isError,true);
  assert.match(asText(await call("grep",{pattern:"changed",path:root})),/small\.txt/);
  assert.match(asText(await call("find",{pattern:"*.txt"})),/small\.txt/);
  assert.match(asText(await call("ls",{})),/small\.txt/);
  const large=join(root,"huge.txt");
  const fh=await open(large,"w");await fh.truncate(33*1024*1024);await fh.close();
  assert.equal((await call("read",{path:"huge.txt"})).isError,true);
  assert.equal((await call("edit",{path:"huge.txt",edits:[{oldText:"any",newText:"x"}]})).isError,true);
  // Full-access mode intentionally accepts absolute paths outside the chosen workspace.
  const outside=await mkdtemp(join(tmpdir(),"ai-local-hub-outside-"));
  try{
    await writeFile(join(outside,"absolute.txt"),"outside workspace");
    assert.match(asText(await call("read",{path:join(outside,"absolute.txt")})),/outside workspace/);
  }finally{await rm(outside,{recursive:true,force:true});}
  if(process.platform!=="win32"){
    // A symlink should not be silently replaced with an ordinary file by an edit.
    await symlink("small.txt",join(root,"alias.txt"));
    const alias=await call("edit",{path:"alias.txt",edits:[{oldText:"changed",newText:"linked"}]});
    assert.notEqual(alias.isError,true);
    assert.match(await readFile(text,"utf8"),/linked/);
  }
  console.log("Rust hardening integration: PASS (shell output/timeout/truncation, memory caps, host/origin, tools, symlink)");
}finally{
  await client.close().catch(()=>{});
  worker.stdin.end();
  await Promise.race([new Promise(r=>worker.once("exit",r)),new Promise(r=>setTimeout(()=>{worker.kill("SIGKILL");r();},5000))]);
  await rm(root,{recursive:true,force:true});
}
