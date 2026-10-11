import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("..",import.meta.url));
const flags=process.argv.slice(2);
const debug=flags.includes("--debug");
const devConfig=flags.includes("--dev-config");
const profile=debug?"debug":"release";
const exe=join(root,"rust/runtime/target",profile,process.platform==="win32"?"ai-local-hub-manager.exe":"ai-local-hub-manager");
if(!existsSync(exe)){
  console.error(`Rust ${profile} manager is not built. Run npm run build${debug?":dev":""} first.`);
  process.exit(1);
}
const env={...process.env,AI_LOCAL_HUB_WEB_DIR:join(root,"dist/web")};
if(devConfig){
  // Development and installed app must never fight over manager.lock,
  // or accidentally start/stop one another's existing instances.
  env.WORKSPACE_TOOLS_CONFIG_FILE=join(homedir(),".config","ai-local-hub-dev","config.json");
  env.WORKSPACE_TOOLS_CACHE_DIR=join(homedir(),".cache","ai-local-hub-dev");
}
const args=flags.filter(flag=>flag!=="--debug" && flag!=="--dev-config");
const result=spawnSync(exe,args,{cwd:root,stdio:"inherit",env});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??(result.signal?130:1));
