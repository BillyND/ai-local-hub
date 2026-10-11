import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("..",import.meta.url));
export const manifest=join(root,"rust/runtime/Cargo.toml");
export function cargoPath() {
  if(process.env.CARGO)return process.env.CARGO;
  const rustup=join(homedir(),".cargo/bin",process.platform==="win32"?"cargo.exe":"cargo");
  if(existsSync(rustup))return rustup;
  const triple=platform()==="darwin"?(arch()==="arm64"?"aarch64-apple-darwin":"x86_64-apple-darwin"):null;
  if(triple){
    const toolchain=join(homedir(),".rustup/toolchains",`stable-${triple}`,"bin","cargo");
    if(existsSync(toolchain))return toolchain;
  }
  return "cargo";
}
export function buildNative({target,release=true}={}){
  const args=["build","--manifest-path",manifest,"--bins",...(release?["--release"]:[]),...(target?["--target",target]:[])];
  const result=spawnSync(cargoPath(),args,{stdio:"inherit",env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error("Native Rust build failed: "+result.status);
  // The installed rust-objcopy may lack libLLVM.dylib on macOS. Using Apple's
  // native strip after Cargo builds avoids silently shipping unstripped binaries.
  if(release && platform()==="darwin"){
    const directory=join(root,"rust/runtime/target",...(target?[target]:[]),"release");
    for(const name of ["ai-local-hub-manager","ai-local-hub-runtime"]){
      const binary=join(directory,name);
      const stripped=spawnSync("/usr/bin/strip",["-S",binary],{stdio:"inherit"});
      if(stripped.error)throw stripped.error;
      if(stripped.status!==0)throw new Error("Could not strip "+binary);
    }
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const i=process.argv.indexOf("--target");
  buildNative({target:i>=0?process.argv[i+1]:undefined,release:!process.argv.includes("--debug")});
}
