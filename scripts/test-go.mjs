// Development verification only. NEVER builds Wails or touches the existing config.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const tmp=mkdtempSync(join(tmpdir(),'ai-local-hub-go-verify-'));
const ext=process.platform==='win32'?'.exe':'';
const worker=join(tmp,'ai-local-hub-runtime'+ext),manager=join(tmp,'ai-local-hub-manager'+ext);
const env={...process.env,GO_WORKER_BIN:worker,GO_MANAGER_BIN:manager};
const exec=(cmd,args,dir=root)=>{
 console.log('\n$ '+cmd+' '+args.join(' '));
 const result=spawnSync(cmd,args,{cwd:dir,env,stdio:'inherit',timeout:180_000});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('Failed '+cmd+' '+args.join(' ')+' (exit '+result.status+')');
};
try{
 const go=process.env.GO_BINARY||'go';
 exec(go,['vet','./...'],join(root,'go'));
 exec(go,['test','-race','./...','-count=1'],join(root,'go'));
 exec(resolve(root,'node_modules/.bin/tsc'),['--noEmit','-p','web/tsconfig.json']);
 exec('npm',['--prefix','web','run','build']);
 exec(go,['build','-o',worker,'./cmd/ai-local-hub-runtime'],join(root,'go'));
 exec(go,['build','-o',manager,'./cmd/ai-local-hub-manager'],join(root,'go'));
 exec('node',['go/tests/manager-smoke.mjs']);
 exec('node',['go/tests/hardening-smoke.mjs']);
 exec('node',['go/tests/tunnel-fixture-smoke.mjs']);
 console.log('\nGO DEVELOPMENT VERIFICATION: PASS (macOS/Linux native only; desktop and remote ChatGPT not tested)');
}finally{rmSync(tmp,{recursive:true,force:true})}
