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
  env:{...process.env,WORKSPACE_ROOT:root,AI_LOCAL_HUB_AUTO_BG_SECS:"off",PATH:process.platform==="darwin"?"/usr/bin:/bin:/usr/sbin:/sbin":process.env.PATH},
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
  assert.match(asText(visible),/VISIBLE_STDERR/);
  assert.match(asText(visible),/Wall time: \d+\.\d\d seconds/);
  const failed=await call("bash",{command:"printf 'failed command'; exit 17"});
  assert.equal(failed.isError,true);
  assert.match(asText(failed),/failed command/);
  assert.match(asText(failed),/Command exited with code 17/);
  if(process.platform!=="win32"){
    const tooMuch=await call("bash",{command:"yes x | head -c 200000"});
    assert.notEqual(tooMuch.isError,true);
    assert.match(asText(tooMuch),/ln elided…\]/);
    assert.match(asText(tooMuch),/Read artifact:\/\/1 for full output\]$/);
    assert.ok(asText(tooMuch).length<52000);
    const timed=await call("bash",{command:"sleep 4",timeout:1});
    assert.equal(timed.isError,true);
    assert.match(asText(timed),/^\[Command timed out after 1 seconds\]/);
  }
  const text=join(root,"small.txt");
  await writeFile(text,"first\nsecond\n");
  const smallRead=asText(await call("read",{path:"small.txt:2-2"}));
  assert.match(smallRead,/2:second/);
  assert.equal((await call("read",{path:"small.txt:0"})).isError,true);
  const smallTag=smallRead.match(/#([0-9A-F]{4})\]/)[1];
  const edit=await call("edit",{input:`[small.txt#${smallTag}]\nPUT 2.=2:\n+changed\n`});
  assert.notEqual(edit.isError,true);
  assert.equal(await readFile(text,"utf8"),"first\nchanged\n");
  assert.equal((await call("edit",{input:"[absent.txt#0000]\nPUT 1.=1:\n+no\n"})).isError,true);
  assert.match(asText(await call("grep",{pattern:"changed",path:root})),/small\.txt/);
  assert.match(asText(await call("glob",{path:"*.txt"})),/small\.txt/);
  assert.match(asText(await call("ls",{})),/small\.txt/);
  const large=join(root,"huge.txt");
  const fh=await open(large,"w");await fh.truncate(33*1024*1024);await fh.close();
  assert.equal((await call("read",{path:"huge.txt"})).isError,true);
  assert.equal((await call("edit",{input:"[huge.txt#0000]\nPUT 1.=1:\n+x\n"})).isError,true);
  // Full-access mode intentionally accepts absolute paths outside the chosen workspace.
  const outside=await mkdtemp(join(tmpdir(),"ai-local-hub-outside-"));
  try{
    await writeFile(join(outside,"absolute.txt"),"outside workspace");
    assert.match(asText(await call("read",{path:join(outside,"absolute.txt")})),/outside workspace/);
  }finally{await rm(outside,{recursive:true,force:true});}
  if(process.platform!=="win32"){
    // A symlink should not be silently replaced with an ordinary file by an edit.
    await symlink("small.txt",join(root,"alias.txt"));
    const aliasTag=asText(await call("read",{path:"alias.txt"})).match(/#([0-9A-F]{4})\]/)[1];
    const alias=await call("edit",{input:`[alias.txt#${aliasTag}]\nPUT 2.=2:\n+linked\n`});
    assert.notEqual(alias.isError,true);
    assert.match(await readFile(text,"utf8"),/linked/);
  }
  // PDFs are parsed in a child process: a valid one is read, and a malformed one whose /Parent chain loops
  // (unbounded recursion in the parser) fails only that call; the worker keeps serving.
  const pdf=objects=>{
    let body="%PDF-1.4\n";const offsets=[];
    objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;});
    const xref=Buffer.byteLength(body);
    body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,"0")+" 00000 n \n").join("");
    return body+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  };
  const content="BT /F1 24 Tf 72 700 Td (Hello PDF worker) Tj ET";
  const stream=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const font="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  await writeFile(join(root,"hello.pdf"),pdf(["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",stream,font]));
  const helloPdf=await call("read",{path:"hello.pdf"});
  assert.notEqual(helloPdf.isError,true,asText(helloPdf));
  assert.match(asText(helloPdf),/Hello PDF worker/);
  await writeFile(join(root,"cyclic.pdf"),pdf(["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",stream,font,
    "<< /Type /Pages /Parent 7 0 R /Kids [3 0 R] /Count 1 >>","<< /Type /Pages /Parent 6 0 R /Kids [] /Count 0 >>"]));
  assert.equal((await call("read",{path:"cyclic.pdf"})).isError,true);
  assert.match(asText(await call("read",{path:"small.txt"})),/first/);
  console.log("Rust hardening integration: PASS (shell output/timeout/truncation, memory caps, host/origin, tools, symlink, PDF isolation)");
}finally{
  await client.close().catch(()=>{});
  worker.stdin.end();
  await Promise.race([new Promise(r=>worker.once("exit",r)),new Promise(r=>setTimeout(()=>{worker.kill("SIGKILL");r();},5000))]);
  await rm(root,{recursive:true,force:true});
}
