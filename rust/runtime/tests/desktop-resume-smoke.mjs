// Desktop mode: after an update restart the shell passes `--instance NAME` for the instances
// that were running; the manager starts exactly those and skips names that no longer exist.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
const root=await mkdtemp(join(tmpdir(),"ai-local-hub-desktop-resume-"));
const bin=resolve("rust/runtime/target/debug",process.platform==="win32"?"ai-local-hub-manager.exe":"ai-local-hub-manager");
const env={...process.env,WORKSPACE_TOOLS_CONFIG_FILE:join(root,"config.json"),
  WORKSPACE_TOOLS_CACHE_DIR:join(root,"cache"),AI_LOCAL_HUB_WEB_DIR:resolve("dist/web")};
const waitFor=async(predicate,message)=>{
  const until=Date.now()+12000;
  while(Date.now()<until){const v=await predicate();if(v)return v;await new Promise(r=>setTimeout(r,100));}
  throw new Error("Timeout: "+message);
};
/** Starts a desktop-mode manager and resolves once its JSON ready line arrives. */
async function launch(args){
  const child=spawn(bin,["--desktop","--local-only",...args],{env,stdio:["pipe","pipe","pipe"]});
  let out="",err="";
  child.stderr.on("data",chunk=>err+=chunk);
  const ready=await Promise.race([
    new Promise((res,rej)=>{
      child.stdout.on("data",chunk=>{out+=chunk;const line=out.split("\n")[0];if(out.includes("\n"))res(JSON.parse(line));});
      child.on("exit",code=>rej(new Error(`Manager exited ${code}: ${err}`)));
    }),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error("startup timed out "+err)),15000)),
  ]);
  assert.equal(ready.type,"ready");
  assert.equal(ready.owner,true);
  const login=await fetch(ready.url,{redirect:"manual"});
  assert.equal(login.status,302);
  assert.match(login.headers.get("content-security-policy"),/connect-src 'self' ipc: http:\/\/ipc\.localhost;/);
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const base=new URL(ready.url).origin;
  const api=async(method,path,body)=>{
    const response=await fetch(base+"/api"+path,{method,
      headers:{cookie,...(body!==undefined?{"content-type":"application/json"}:{}),...(method!=="GET"?{origin:base}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text();
    return {status:response.status,data:raw?JSON.parse(raw):undefined,raw};
  };
  // The desktop window keeps this event stream open for as long as it shows the UI.
  const watchEvents=async()=>{
    const response=await fetch(base+"/api/events",{headers:{cookie}});
    assert.equal(response.status,200);
    const reader=response.body.getReader();
    (async()=>{try{while(!(await reader.read()).done){}}catch{}})();
  };
  // Closing stdin is how the desktop shell stops the manager; returns how long that took.
  const stop=async()=>{
    const started=Date.now();
    child.stdin.end();
    await Promise.race([new Promise(r=>child.once("exit",r)),new Promise(r=>setTimeout(()=>{child.kill("SIGKILL");r();},20000))]);
    return Date.now()-started;
  };
  return {api,stop,watchEvents};
}
const states=async api=>Object.fromEntries((await api("GET","/state")).data.instances.map(i=>[i.name,i.status.state]));

let manager;
try{
  manager=await launch([]);
  for(const name of ["alpha","beta"]){
    const workspace=join(root,name);await mkdir(workspace);
    const created=await manager.api("POST","/instances",{name,workspaceRoot:workspace,tunnelId:"demo-"+name,apiKey:"sk-"+name,toolGroups:["core"]});
    assert.equal(created.status,201,created.raw);
  }
  assert.deepEqual(await states(manager.api),{alpha:"stopped",beta:"stopped"});
  await manager.stop();

  manager=await launch(["--instance","Alpha","--instance","deleted-meanwhile"]);
  await waitFor(async()=>(await states(manager.api)).alpha==="running","resumed instance running");
  assert.equal((await states(manager.api)).beta,"stopped");
  // An open event stream must not hold the shutdown (the shell would wait 20 s, then kill).
  await manager.watchEvents();
  const elapsed=await manager.stop();
  manager=null;
  assert.ok(elapsed<5000,`manager took ${elapsed} ms to stop with an open event stream`);
  console.log("Desktop resume after update: PASS");
}finally{
  await manager?.stop();
  await rm(root,{recursive:true,force:true});
}
