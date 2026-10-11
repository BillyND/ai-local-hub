import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=await mkdtemp(join(tmpdir(),'ai-local-hub-go-tunnel-test-'));const bin=join(root,'fake-tunnel-client');
const script=`#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const args=process.argv.slice(2);const arg=name=>args[args.indexOf(name)+1];
if(args[0]==='init'){fs.mkdirSync(arg('--profile-dir'),{recursive:true});fs.writeFileSync(path.join(arg('--profile-dir'),'initialized'),'1');process.exit(0)}
if(args[0]!=='run')process.exit(3);
if(!process.env.CONTROL_PLANE_API_KEY||!fs.existsSync(path.join(arg('--profile-dir'),'initialized')))process.exit(4);
const server=http.createServer((req,res)=>{if(req.url==='/readyz'||req.url==='/healthz'){res.writeHead(200);res.end('ok')}else{res.writeHead(404);res.end()}});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(arg('--health.url-file'),'http://127.0.0.1:'+server.address().port)});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
await writeFile(bin,script,{mode:0o700});await chmod(bin,0o700);
const runtime=process.env.GO_WORKER_BIN||'/tmp/ai-local-hub-go-worker-dev';const cache=join(root,'cache');const child=spawn(runtime,[],{env:{...process.env,WORKSPACE_ROOT:root,WORKSPACE_TOOLS_CACHE_DIR:cache,WORKSPACE_TOOLS_TUNNEL_BIN:bin,OPENAI_TUNNEL_ID:'test-fixture',OPENAI_API_KEY:'sk-test-tunnel-only'},stdio:['pipe','pipe','pipe']});
let text='',stderr='',mcpURL;let onReady,onFail;const ready=new Promise((resolve,reject)=>{onReady=resolve;onFail=reject});child.stderr.on('data',v=>stderr+=v);child.stdout.on('data',v=>{text+=v;const lines=text.split('\n');text=lines.pop();for(const line of lines){try{const e=JSON.parse(line);if(e.type==='mcp')mcpURL=e.url;if(e.type==='fatal')onFail(Error(e.message));if(e.type==='ready')onReady({e,url:mcpURL})}catch{}}});child.on('error',onFail);
try{const {e,url}=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('tunnel fixture timeout '+stderr)),12000))]);assert.equal(e.tunnel,true);const client=new Client({name:'go-tunnel-fixture',version:'1'});try{await client.connect(new StreamableHTTPClientTransport(new URL(url)));const r=await client.callTool({name:'ls',arguments:{path:'.'}});assert.notEqual(r.isError,true)}finally{await client.close()};assert.ok(!(stderr+text).includes('sk-test-tunnel-only'));console.log('GO tunnel fixture: PASS (init/run, scoped environment, health/ready, MCP, no key in logs)')}finally{child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(()=>{child.kill('SIGKILL');r()},5000))]);try{assert.equal((await readdir(join(cache,'runtime'))).length,0);console.log('GO tunnel profile cleanup: PASS')}catch(err){console.error('GO tunnel profile cleanup FAIL',err);process.exitCode=1};await rm(root,{recursive:true,force:true})}
