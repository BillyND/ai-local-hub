import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,chmod,mkdir} from "node:fs/promises";
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
child.on("exit",code=>reject(new Error("Manager exited "+code+" "+err+" "+out)));
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
 } finally{await client.close();}
 // Two instances must remain independently accessible and stoppable.
 const otherRoot=join(root,"second");await mkdir(otherRoot);
const second=await api("POST","/instances",{name:"second",workspaceRoot:otherRoot,tunnelId:"demo2",apiKey:"sk-for-second",toolGroups:["core"]});
assert.equal(second.status,201);
assert.deepEqual(second.data.toolGroups,["core"]);
const secondId=second.data.id;
 assert.equal((await api("POST",`/instances/${secondId}/start`,{})).status,200);
 const secondView=await waitFor(async()=>{
   const s=await api("GET","/state");
   const second=s.data.instances.find(i=>i.id===secondId);
   return second?.status.state==="running"?second:null;
 },"second worker running");
const secondClient=new Client({name:"second-worker-smoke",version:"1"});
try{
  await secondClient.connect(new StreamableHTTPClientTransport(new URL(secondView.status.url)));
  const secondTools=(await secondClient.listTools()).tools.map((tool)=>tool.name).sort();
  assert.deepEqual(secondTools,["bash","edit","glob","grep","kill_job","read","wait","write"]);
  assert.notEqual((await secondClient.callTool({name:"write",arguments:{path:"isolated.txt",content:"second only"}})).isError,true);
  assert.equal(await readFile(join(otherRoot,"isolated.txt"),"utf8"),"second only");
  await assert.rejects(() => secondClient.callTool({name:"lsp",arguments:{action:"status"}}), /tool not found|Method not found|Invalid params/);
}finally{await secondClient.close();}
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
 assert.equal((await api("GET","/state")).data.instances.find(i=>i.id===secondId).status.state,"running");
 assert.equal((await api("POST",`/instances/${secondId}/stop`,{})).status,200);
 await waitFor(async()=>(await api("GET","/state")).data.instances.find(i=>i.id===secondId).status.state==="stopped","stop second worker");
 assert.equal((await api("DELETE",`/instances/${secondId}`)).status,204);
 assert.equal((await api("DELETE",`/instances/${id}`)).status,204);
 assert.equal((await api("GET","/state")).data.instances.length,0);
 assert.equal((await api("POST","/shutdown",{})).status,202);
 console.log("Rust native full-stack manager integration: PASS",base);
}finally{
 child.stdin.end();
 await Promise.race([new Promise(r=>child.once("exit",r)),new Promise(r=>setTimeout(()=>{child.kill("SIGKILL");r();},7000))]);
 await rm(root,{recursive:true,force:true});
}
