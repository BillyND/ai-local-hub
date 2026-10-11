// Stage native Rust sidecars and the prebuilt React UI for Tauri.
// No Bun, Node.js or JavaScript server code ships in the desktop installer.
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {chmodSync,cpSync,existsSync,mkdirSync,rmSync} from "node:fs";
import {join} from "node:path";
import {buildNative,cargoPath} from "./native-build.mjs";
const root=fileURLToPath(new URL("..",import.meta.url));
const index=process.argv.indexOf("--target");
let target=process.argv[index+1];
if(index<0){
  const output=execFileSync(cargoPath(),["-vV"],{encoding:"utf8"});
  // Cargo's host triple is the default build target when --target is not set.
  target=/^host: (\S+)/m.exec(output)?.[1];
}
if(!target)throw new Error("Could not determine target triple");
const windows=target.includes("windows");
const bin=join(root,"desktop/src-tauri/binaries");
const resources=join(root,"desktop/src-tauri/resources/app");
if(!existsSync(join(root,"dist/web/index.html")))throw new Error("Web UI not built. Run npm run build.");
buildNative({target});
rmSync(bin,{recursive:true,force:true});
mkdirSync(bin,{recursive:true});
for(const name of ["ai-local-hub-manager","ai-local-hub-runtime"]){
  const source=join(root,"rust/runtime/target",target,"release",name+(windows?".exe":""));
  if(!existsSync(source))throw new Error("Rust binary not found: "+source);
  const output=join(bin,`${name}-${target}${windows?".exe":""}`);
  cpSync(source,output);
  if(!windows)chmodSync(output,0o755);
}
rmSync(resources,{recursive:true,force:true});
mkdirSync(join(resources,"dist"),{recursive:true});
cpSync(join(root,"dist/web"),join(resources,"dist/web"),{recursive:true});
console.log("Staged native Rust desktop binaries and web UI:",target);
