// Fail release packaging if Tauri reports success but no usable native macOS DMG exists.
// This catches hdiutil conversions that leave only rw.* intermediate images.
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("..",import.meta.url));
const targetIndex=process.argv.indexOf("--target");
const target=targetIndex>=0?process.argv[targetIndex+1]:undefined;
const release=join(root,"desktop/src-tauri/target",...(target?[target]:[]),"release");
if(process.platform!=="darwin"){
  console.log("DMG validation is macOS-only; other platforms require their own artifact checks.");
  process.exit(0);
}
const bundle=join(release,"bundle");
const app=join(bundle,"macos","AI_Local_Hub.app","Contents","MacOS");
for(const name of ["ai-local-hub-desktop","ai-local-hub-manager","ai-local-hub-runtime"]){
  const path=join(app,name);
  if(!existsSync(path)||statSync(path).size<50_000)throw new Error("Missing or invalid native binary: "+path);
}
const dmgs=join(bundle,"dmg");
const candidates=existsSync(dmgs)?readdirSync(dmgs).filter(f=>f.endsWith(".dmg")):[];
if(candidates.length===0)throw new Error("No final DMG exists in "+dmgs+". Check 'hdiutil info' for stale mounted rw.* images.");
for(const file of candidates){
  const path=join(dmgs,file);
  if(statSync(path).size<1024*1024)throw new Error("Incomplete DMG: "+path);
  execFileSync("/usr/bin/hdiutil",["verify",path],{stdio:"ignore"});
  console.log("Verified DMG:",path);
}
console.log("Verified all 3 packaged native executables.");
