import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {rustBuildEnv} from "./native-build.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const desktop=join(root,"desktop");
const tauri=join(desktop,"node_modules",".bin",process.platform==="win32"?"tauri.cmd":"tauri");
if(!existsSync(tauri)) throw new Error(`Tauri CLI not found: ${tauri}. Run npm run desktop:setup first.`);

const args=process.argv.slice(2);
const result=spawnSync(tauri,args,{cwd:desktop,stdio:"inherit",env:rustBuildEnv(),shell:process.platform==="win32"});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status ?? 1);
