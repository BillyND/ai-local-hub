// Build Go CLI only (never desktop) then compare release workers using an identical MCP fixture.
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const rust=process.env.RUST_WORKER_BIN||join(root,'rust/runtime/target/release','ai-local-hub-runtime'+(process.platform==='win32'?'.exe':''));
if(!existsSync(rust))throw Error('Rust release worker not found. Run npm run build:rust first (not desktop).');
const temp=mkdtempSync(join(tmpdir(),'ai-local-hub-benchmark-'));
try{
 const go=join(temp,'ai-local-hub-runtime'+(process.platform==='win32'?'.exe':''));
 let run=spawnSync(process.env.GO_BINARY||'go',['build','-o',go,'./cmd/ai-local-hub-runtime'],{cwd:join(root,'go'),stdio:'inherit'});
 if(run.status!==0)throw Error('Go CLI build failed');
 run=spawnSync('node',['go/tests/benchmark.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,GO_WORKER_BIN:go,RUST_WORKER_BIN:rust}});
 if(run.status!==0)throw Error('Benchmark failed');
}finally{rmSync(temp,{recursive:true,force:true})}
