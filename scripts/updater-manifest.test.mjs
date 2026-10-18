import assert from "node:assert/strict";
import test from "node:test";
import {buildManifest} from "./updater-manifest.mjs";

const RELEASE=[
  "AI_Local_Hub_0.5.0_aarch64.app.tar.gz",
  "AI_Local_Hub_0.5.0_x64.app.tar.gz",
  "AI_Local_Hub_0.5.0_x64-setup.exe",
  "AI_Local_Hub_0.5.0_x64_en-US.msi",
  "AI_Local_Hub_0.5.0_amd64.AppImage",
  "AI_Local_Hub_0.5.0_amd64.deb",
  "AI_Local_Hub_0.5.0_aarch64.dmg",
  "AI_Local_Hub_0.5.0_x64.dmg",
].map(name=>`assets/nested/${name}`);
const build=(files,signature=path=>`sig:${path.split("/").pop()}\n`)=>buildManifest({
  files,signature,tag:"v0.5.0",version:"0.5.0",repo:"BillyND/ai-local-hub",notes:"Notes",pubDate:"2026-10-18T00:00:00.000Z",
});

test("maps every updater artifact to its platform keys",()=>{
  const manifest=build(RELEASE);
  assert.equal(manifest.version,"0.5.0");
  assert.deepEqual(Object.keys(manifest.platforms).sort(),[
    "darwin-aarch64","darwin-aarch64-app","darwin-x86_64","darwin-x86_64-app",
    "linux-x86_64","linux-x86_64-appimage","linux-x86_64-deb",
    "windows-x86_64","windows-x86_64-msi","windows-x86_64-nsis",
  ]);
  assert.deepEqual(manifest.platforms["windows-x86_64"],{
    signature:"sig:AI_Local_Hub_0.5.0_x64-setup.exe",
    url:"https://github.com/BillyND/ai-local-hub/releases/download/v0.5.0/AI_Local_Hub_0.5.0_x64-setup.exe",
  });
  assert.equal(manifest.platforms["darwin-aarch64"].url.endsWith("_aarch64.app.tar.gz"),true);
  assert.equal(manifest.platforms["linux-x86_64-deb"].url.endsWith("_amd64.deb"),true);
});

test("refuses a release that leaves a platform without an update",()=>{
  assert.throws(()=>build(RELEASE.filter(path=>!path.endsWith("_x64.app.tar.gz"))),/darwin-x86_64/);
  assert.throws(()=>build(RELEASE.filter(path=>!path.endsWith(".msi"))),/windows-x86_64-msi/);
  assert.throws(()=>build(RELEASE.filter(path=>!path.endsWith(".deb"))),/linux-x86_64-deb/);
});

test("refuses a tag that differs from the version the packages were signed as",()=>{
  assert.throws(()=>buildManifest({files:RELEASE,signature:()=>"sig",tag:"v0.5.1",version:"0.5.0",repo:"r/r",notes:"",pubDate:""}),/Tag v0.5.1 does not match the app version 0.5.0/);
});

test("refuses an unsigned updater artifact",()=>{
  assert.throws(()=>build(RELEASE,path=>path.endsWith(".deb")?undefined:"sig"),/no signature: .*\.deb/);
});

test("refuses two artifacts for the same platform",()=>{
  assert.throws(()=>build([...RELEASE,"other/AI_Local_Hub_0.4.9_aarch64.app.tar.gz"]),/Two updater artifacts for darwin-aarch64/);
});
