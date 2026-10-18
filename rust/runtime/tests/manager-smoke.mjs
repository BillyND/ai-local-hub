import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,chmod,mkdir,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const root=await mkdtemp(join(tmpdir(),"ai-local-hub-native-manager-"));
const bin=resolve("rust/runtime/target/debug",process.platform==="win32"?"ai-local-hub-manager.exe":"ai-local-hub-manager");
const child=spawn(bin,["--local-only","--port","0","--no-open"],{
    env:{...process.env,WORKSPACE_TOOLS_CONFIG_FILE:join(root,"config.json"),
         WORKSPACE_TOOLS_CACHE_DIR:join(root,"cache"),AI_LOCAL_HUB_WEB_DIR:resolve("dist/web")},
    stdio:["pipe","pipe","pipe"]
});
let out="",err="";
child.stderr.on("data",chunk=>err+=chunk);
let fulfill,reject;
const started=new Promise((res,rej)=>{fulfill=res;reject=rej});
child.stdout.on("data",chunk=>{
  out+=chunk;
  const link=out.match(/Open: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/)?.[1];
  if(link)fulfill(link);
});
child.once("exit",code=>reject(new Error("Manager exited "+code+" "+err+" "+out)));
let jobPid=0;
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const waitFor=async(predicate,message)=>{
  const until=Date.now()+12000;
  while(Date.now()<until){const v=await predicate();if(v)return v;await new Promise(r=>setTimeout(r,100));}
  throw new Error("Timeout: "+message+" "+err);
};
try {
 const link=await Promise.race([started,new Promise((_,rej)=>setTimeout(()=>rej(new Error("startup timed out "+err)),15000))]);
 const base=new URL(link).origin;
 let r=await fetch(base+"/api/state",{redirect:"manual"});assert.equal(r.status,401);
 r=await fetch(link,{redirect:"manual"});assert.equal(r.status,302);
 // Only the desktop app may reach Tauri's IPC endpoint.
 assert.match(r.headers.get("content-security-policy"),/connect-src 'self';/);
 const cookie=r.headers.get("set-cookie").split(";")[0];
 assert.ok(cookie.startsWith("wtm_session="));
 async function api(method,path,body){
   const response=await fetch(base+"/api"+path,{
     method,headers:{cookie,...(body!==undefined?{"content-type":"application/json"}:{}),...(method!=="GET"?{origin:base}:{})},
     body:body===undefined?undefined:JSON.stringify(body)
   });
   const raw=await response.text();
   return {status:response.status,data:raw?JSON.parse(raw):undefined,raw};
 }
 r=await api("GET","/state");
 assert.equal(r.status,200);assert.equal(r.data.instances.length,0);
 const payload={name:"test",workspaceRoot:root,tunnelId:"demo",apiKey:"sk-for-test"};
 const created=await api("POST","/instances",payload);
 assert.equal(created.status,201,created.raw);
 const id=created.data.id;
 assert.ok(!created.raw.includes(payload.apiKey));
 assert.ok((await readFile(join(root,"config.json"),"utf8")).includes(payload.apiKey));
 const edited=await api("PUT",`/instances/${id}`,{name:"updated",workspaceRoot:root,tunnelId:"demo"});
 assert.equal(edited.status,200,edited.raw);
 assert.equal(edited.data.name,"updated");
 // A failed atomic save must never leave the manager's in-memory state
 // claiming an update/delete that was not persisted.
 if(process.platform!=="win32"){
   await chmod(root,0o500);
   try {
     const denied=await api("PUT",`/instances/${id}`,{name:"should-not-save",workspaceRoot:root,tunnelId:"demo"});
     assert.equal(denied.status,500);
     const unchanged=await api("GET","/state");
     assert.equal(unchanged.data.instances[0].name,"updated");
     const deniedDelete=await api("DELETE",`/instances/${id}`);
     assert.equal(deniedDelete.status,500);
     assert.equal((await api("GET","/state")).data.instances.length,1);
   }finally{await chmod(root,0o700);}
 }
 const bad=await api("POST","/instances",payload);
 assert.equal(bad.status,400);
 const startedWorker=await api("POST",`/instances/${id}/start`,{});
 assert.equal(startedWorker.status,200);
 const view=await waitFor(async()=>{
   const s=await api("GET","/state");
   return s.data.instances[0].status.state==="running"?s.data.instances[0]:null;
 },"worker running");
 assert.match(view.status.url,/127\.0\.0\.1:\d+\/mcp/);
 const client=new Client({name:"rust-full-stack-smoke",version:"1"});
 try {
   await client.connect(new StreamableHTTPClientTransport(new URL(view.status.url)));
   const w=await client.callTool({name:"write",arguments:{path:"native.txt",content:"rust worker"}});
   assert.notEqual(w.isError,true);
   assert.equal(await readFile(join(root,"native.txt"),"utf8"),"rust worker");
   // A `timeout: 0` background job (dev server, watcher) must not outlive its instance.
   const job=await client.callTool({name:"bash",arguments:{command:"echo $$ > job.pid; exec sleep 300",timeout:0,async:true}});
   assert.notEqual(job.isError,true,JSON.stringify(job));
   jobPid=Number(await waitFor(async()=>{try{return (await readFile(join(root,"job.pid"),"utf8")).trim()||null}catch{return null}},"background job pid"));
   assert.ok(alive(jobPid),"background job is running");
 } finally{await client.close();}
 // Two instances must remain independently accessible and stoppable.
 const otherRoot=join(root,"second");await mkdir(otherRoot);
const fixture=resolve("rust/runtime/tests/fixtures/fake-mcp-server.mjs");
const mcpSecret="tok-manager-secret";
const mcpServers={fake:{command:process.execPath,args:[fixture],env:{FAKE_TOKEN:mcpSecret},tools:["echo","whoami"]}};
const second=await api("POST","/instances",{name:"second",workspaceRoot:otherRoot,tunnelId:"demo2",apiKey:"sk-for-second",toolGroups:["core"],mcpServers});
assert.equal(second.status,201);
assert.deepEqual(second.data.toolGroups,["core"]);
// MCP server env values are write-only: masked in every response, kept on disk, kept when sent back masked.
assert.equal(second.data.mcpServers.fake.env.FAKE_TOKEN,"<hidden>");
assert.ok(!second.raw.includes(mcpSecret));
assert.ok(!(await api("GET","/state")).raw.includes(mcpSecret));
assert.ok((await readFile(join(root,"config.json"),"utf8")).includes(mcpSecret));
const invalid=await api("POST","/instances",{name:"bad-mcp",workspaceRoot:otherRoot,tunnelId:"demo3",apiKey:"k",mcpServers:{"a__b":{command:"x"}}});
assert.equal(invalid.status,400);
assert.match(invalid.data.error,/must be 1-32 letters/);
const malformed=await api("POST","/instances",{name:"bad-mcp",workspaceRoot:otherRoot,tunnelId:"demo3",apiKey:"k",mcpServers:{a:{args:[]}}});
assert.equal(malformed.status,400);
assert.match(malformed.data.error,/^Invalid request body: .*command/);
const secondId=second.data.id;
 assert.equal((await api("POST",`/instances/${secondId}/start`,{})).status,200);
 const secondView=await waitFor(async()=>{
   const s=await api("GET","/state");
   const second=s.data.instances.find(i=>i.id===secondId);
   return second?.status.state==="running"?second:null;
 },"second worker running");
const secondClient=new Client({name:"second-worker-smoke",version:"1"});
let secondFake;
try{
  await secondClient.connect(new StreamableHTTPClientTransport(new URL(secondView.status.url)));
  const secondTools=(await secondClient.listTools()).tools.map((tool)=>tool.name);
  assert.deepEqual(secondTools.filter(n=>!n.includes("__")).sort(),["bash","edit","glob","grep","kill_job","read","wait","write"]);
  assert.deepEqual(secondTools.filter(n=>n.includes("__")),["fake__echo","fake__whoami"]);
  const who=JSON.parse((await secondClient.callTool({name:"fake__whoami",arguments:{}})).content[0].text);
  assert.equal(who.token,mcpSecret);
  assert.equal(who.cwd,await realpath(otherRoot));
  secondFake=who;
  assert.notEqual((await secondClient.callTool({name:"write",arguments:{path:"isolated.txt",content:"second only"}})).isError,true);
  assert.equal(await readFile(join(otherRoot,"isolated.txt"),"utf8"),"second only");
  await assert.rejects(() => secondClient.callTool({name:"lsp",arguments:{action:"status"}}), /tool not found|Method not found|Invalid params/);
}finally{await secondClient.close();}
 const resent=await api("PUT",`/instances/${secondId}`,{name:"second",workspaceRoot:otherRoot,tunnelId:"demo2",toolGroups:["core"],mcpServers:{fake:{...mcpServers.fake,env:{FAKE_TOKEN:"<hidden>"},timeoutSecs:30}}});
 assert.equal(resent.status,200);
 assert.equal(resent.data.mcpServers.fake.timeoutSecs,30);
 assert.ok((await readFile(join(root,"config.json"),"utf8")).includes(mcpSecret),"masked value replaced the saved secret");
 const omitted=await api("PUT",`/instances/${secondId}`,{name:"second",workspaceRoot:otherRoot,tunnelId:"demo2",toolGroups:["core"]});
 assert.deepEqual(Object.keys(omitted.data.mcpServers),["fake"],"older clients that omit mcpServers must not erase them");
 const secondLogs=(await api("GET",`/instances/${secondId}/logs`)).data.lines;
 assert.ok(secondLogs.some(l=>l==="[mcp:fake] token [REDACTED]"),"upstream stderr is forwarded with secrets redacted");
 assert.ok(!secondLogs.some(l=>l.includes(mcpSecret)));
 // Every tool call must leave one structured line in the instance Logs panel.
 const logs=await api("GET",`/instances/${id}/logs`);
 assert.equal(logs.status,200);
 const toolLog=logs.data.lines.map(line=>{try{return JSON.parse(line)}catch{return null}}).find(r=>r?.tool==="write");
 assert.ok(toolLog,"write call is logged");
 assert.equal(toolLog.msg,"tool write ok");
 assert.equal(toolLog.level,"INFO");
 assert.equal(toolLog.path,"native.txt");
 assert.equal(toolLog.bytes,"rust worker".length);
 assert.equal(typeof toolLog.duration_ms,"number");
 assert.ok(!Number.isNaN(Date.parse(toolLog.time)),"ISO time");
 assert.equal((await api("POST",`/instances/${id}/stop`,{})).status,200);
 await waitFor(async()=>(await api("GET","/state")).data.instances.find(i=>i.id===id).status.state==="stopped","stop first worker");
 await waitFor(async()=>!alive(jobPid),"background job stopped with its instance");
 assert.equal((await api("GET","/state")).data.instances.find(i=>i.id===secondId).status.state,"running");
 if(process.platform!=="win32"){
   // A worker killed outright cannot stop its MCP servers; the manager kills their process groups instead.
   const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
   const workerPid=Number(await new Promise(r=>{let o="";const p=spawn("ps",["-o","ppid=","-p",String(secondFake.pid)]);p.stdout.on("data",c=>o+=c);p.on("close",()=>r(o.trim()))}));
   assert.ok(workerPid>1,"worker pid of the MCP server");
   process.kill(workerPid,"SIGKILL");
   await waitFor(async()=>(await api("GET","/state")).data.instances.find(i=>i.id===secondId).status.state==="error","killed worker reported");
   await waitFor(async()=>!alive(secondFake.pid)&&!alive(secondFake.grandchild),"MCP server group outlived a killed worker");
 }
 assert.equal((await api("POST",`/instances/${secondId}/stop`,{})).status,200);
 await waitFor(async()=>(await api("GET","/state")).data.instances.find(i=>i.id===secondId).status.state==="stopped","stop second worker");
 assert.equal((await api("DELETE",`/instances/${secondId}`)).status,204);
 assert.equal((await api("DELETE",`/instances/${id}`)).status,204);
 assert.equal((await api("GET","/state")).data.instances.length,0);
 // An open UI event stream must not hold the manager after Quit.
 const events=await fetch(base+"/api/events",{headers:{cookie}});
 assert.equal(events.status,200);
 const exited=new Promise(r=>child.once("exit",code=>r(code)));
 assert.equal((await api("POST","/shutdown",{})).status,202);
 const code=await Promise.race([exited,new Promise(r=>setTimeout(()=>r("hung"),8000))]);
 assert.equal(code,0,"manager exits after Quit while the UI is connected");
 await events.body?.cancel().catch(()=>{});
 console.log("Rust native full-stack manager integration: PASS",base);
}finally{
 child.stdin.end();
 if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(r=>child.once("exit",r)),new Promise(r=>setTimeout(()=>{child.kill("SIGKILL");r();},7000))]);
 if(jobPid&&alive(jobPid))process.kill(jobPid,"SIGKILL");
 await rm(root,{recursive:true,force:true});
}
