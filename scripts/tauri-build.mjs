import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {rustBuildEnv} from "./native-build.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const desktop=join(root,"desktop");
const cli=join(desktop,"node_modules","@tauri-apps","cli","tauri.js");
const shim=join(desktop,"node_modules",".bin",process.platform==="win32"?"tauri.cmd":"tauri");
const command=process.platform==="win32"?process.execPath:shim;
const commandArgs=process.platform==="win32"?[cli,...process.argv.slice(2)]:process.argv.slice(2);
if(!existsSync(process.platform==="win32"?cli:shim)) throw new Error(`Tauri CLI not found: ${process.platform==="win32"?cli:shim}. Run npm run desktop:setup first.`);

const result=spawnSync(command,commandArgs,{cwd:desktop,stdio:"inherit",env:rustBuildEnv()});
