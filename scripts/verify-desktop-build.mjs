// Fail release packaging if Tauri reports success but no usable native installer exists.
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoPath, rustBuildEnv } from "./native-build.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const targetIndex=process.argv.indexOf("--target");
let target=targetIndex>=0?process.argv[targetIndex+1]:undefined;
if(!target){
  const output=execFileSync(cargoPath(),["-vV"],{encoding:"utf8",env:rustBuildEnv()});
  target=/^host: (\S+)/m.exec(output)?.[1];
}
if(!target)throw new Error("Could not determine Rust target triple");

const targeted=targetIndex>=0;
const release=join(root,"desktop/src-tauri/target",...(targeted?[target]:[]),"release");
const native=join(root,"rust/runtime/target",...(targeted?[target]:[]),"release");
for(const name of ["ai-local-hub-manager","ai-local-hub-runtime"]){
  const path=join(native,name+ (target.includes("windows")?".exe":""));
  if(!existsSync(path)||statSync(path).size<50_000)throw new Error("Missing or invalid native binary: "+path);
}

const bundle=join(release,"bundle");
const files=(directory, suffixes)=>existsSync(directory)
  ? readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
      const path=join(directory,entry.name);
      if(entry.isDirectory())return files(path,suffixes);
      return suffixes.some(suffix=>entry.name.endsWith(suffix))?[path]:[];
    })
  : [];
const requireArtifacts=(suffixes,label,directory=bundle)=>{
  const candidates=files(directory,suffixes);
  if(candidates.length===0)throw new Error(`No ${label} exists in ${directory}`);
  for(const path of candidates){
    if(statSync(path).size<1024*1024)throw new Error(`Incomplete ${label}: ${path}`);
    console.log(`Verified ${label}:`,path);
  }
  return candidates;
};

if(target.includes("apple-darwin")){
  const app=join(bundle,"macos","AI_Local_Hub.app","Contents","MacOS");
  for(const name of ["ai-local-hub-desktop","ai-local-hub-manager","ai-local-hub-runtime"]){
    const path=join(app,name);
    if(!existsSync(path)||statSync(path).size<50_000)throw new Error("Missing or invalid packaged executable: "+path);
  }
  for(const path of requireArtifacts([".dmg"],"DMG",join(bundle,"dmg")))execFileSync("/usr/bin/hdiutil",["verify",path],{stdio:"ignore"});
  console.log("Verified macOS app bundle and 3 packaged native executables.");
}else if(target.includes("windows")){
  requireArtifacts([".msi",".exe"],"Windows installer");
  console.log("Verified Windows installer and 2 native release binaries.");
}else if(target.includes("linux")){
  requireArtifacts([".AppImage",".deb"],"Linux installer");
  console.log("Verified Linux installers and 2 native release binaries.");
}else{
  throw new Error(`Unsupported release target: ${target}`);
}
