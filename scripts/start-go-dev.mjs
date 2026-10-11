// Safe Go development launcher: isolated temporary config by default.
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const scratch=mkdtempSync(join(tmpdir(),'ai-local-hub-go-dev-'));
const exe=process.platform==='win32'?'.exe':'';
const worker=join(scratch,'ai-local-hub-runtime'+exe),manager=join(scratch,'ai-local-hub-manager'+exe);
const go=process.env.GO_BINARY||'go';
for(const [name,path] of [['ai-local-hub-runtime',worker],['ai-local-hub-manager',manager]]){
 const p=spawnSync(go,['build','-o',path,'./cmd/'+name],{cwd:join(root,'go'),stdio:'inherit'});if(p.status!==0)process.exit(p.status||1);
}
const config=process.env.WORKSPACE_TOOLS_CONFIG_FILE||join(scratch,'config.json');
const cache=process.env.WORKSPACE_TOOLS_CACHE_DIR||join(scratch,'cache');mkdirSync(cache,{recursive:true});
console.log('Go DEV isolated config:',config,'\nGo DEV cache:',cache,'\nProduction processes and config are untouched.');
const child=spawn(manager,['--local-only','--port','0','--worker',worker,'--web',join(root,'dist/web'),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,WORKSPACE_TOOLS_CONFIG_FILE:config,WORKSPACE_TOOLS_CACHE_DIR:cache}});
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>child.kill(s));
child.on('exit',code=>process.exit(code||0));
