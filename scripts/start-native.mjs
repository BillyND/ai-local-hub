import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("..",import.meta.url));
const exe=join(root,"rust/runtime/target/release",process.platform==="win32"?"ai-local-hub-manager.exe":"ai-local-hub-manager");
if(!existsSync(exe)){
  console.error("Rust manager is not built. Run npm run build first.");
  process.exit(1);
}
const result=spawnSync(exe,process.argv.slice(2),{
  cwd:root,stdio:"inherit",env:{...process.env,AI_LOCAL_HUB_WEB_DIR:join(root,"dist/web")}
});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??(result.signal?130:1));
