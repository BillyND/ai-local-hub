// Build the `latest.json` the desktop updater reads from the latest GitHub release.
// Every updater artifact is matched to its platform key and paired with its `.sig` file.
import {existsSync,readdirSync,readFileSync,writeFileSync} from "node:fs";
import {basename,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

// The plugin looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
const KINDS=[
  {pattern:/_aarch64\.app\.tar\.gz$/,keys:["darwin-aarch64-app","darwin-aarch64"]},
  {pattern:/_x64\.app\.tar\.gz$/,keys:["darwin-x86_64-app","darwin-x86_64"]},
  {pattern:/_x64-setup\.exe$/,keys:["windows-x86_64-nsis","windows-x86_64"]},
  {pattern:/_x64_[^_]+\.msi$/,keys:["windows-x86_64-msi"]},
  {pattern:/_amd64\.AppImage$/,keys:["linux-x86_64-appimage","linux-x86_64"]},
  {pattern:/_amd64\.deb$/,keys:["linux-x86_64-deb"]},
];
// A release without one of these would leave that platform (or installer type) unable to update;
// a missing MSI entry would also make MSI installs fall back to the NSIS installer.
export const REQUIRED=["darwin-aarch64","darwin-x86_64","windows-x86_64","windows-x86_64-msi","linux-x86_64","linux-x86_64-deb"];

/**
 * `files`: artifact paths; `signature(path)`: the `.sig` text for a path, or undefined;
 * `version`: the version the packages were built (and signed) as.
 */
export function buildManifest({files,signature,tag,repo,notes,pubDate,version}){
  // The updater rejects a package whose signed version differs from the announced one.
  if(tag!==`v${version}`)throw new Error(`Tag ${tag} does not match the app version ${version}`);
  const platforms={};
  for(const path of files){
    const name=basename(path);
    const kind=KINDS.find(k=>k.pattern.test(name));
    if(!kind)continue;
    const sig=signature(path)?.trim();
    if(!sig)throw new Error(`Updater artifact has no signature: ${name}`);
    const url=`https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    for(const key of kind.keys){
      if(platforms[key])throw new Error(`Two updater artifacts for ${key}: ${basename(platforms[key].url)} and ${name}`);
      platforms[key]={signature:sig,url};
    }
  }
  const missing=REQUIRED.filter(key=>!platforms[key]);
  if(missing.length)throw new Error(`No updater artifact for ${missing.join(", ")}`);
  return {version,notes,pub_date:pubDate,platforms};
}

const walk=directory=>readdirSync(directory,{withFileTypes:true})
  .flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]);

function main(){
  const arg=name=>{const i=process.argv.indexOf(`--${name}`);return i>=0?process.argv[i+1]:undefined;};
  const assets=arg("assets"),tag=arg("tag"),repo=arg("repo"),out=arg("out");
  if(!assets||!tag||!repo||!out)throw new Error("Usage: updater-manifest.mjs --assets DIR --tag vX.Y.Z --repo OWNER/NAME --out FILE [--notes FILE]");
  const notesFile=arg("notes");
  const manifest=buildManifest({
    files:walk(assets).filter(path=>!path.endsWith(".sig")),
    signature:path=>existsSync(`${path}.sig`)?readFileSync(`${path}.sig`,"utf8"):undefined,
    tag,repo,
    version:JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),"..","package.json"),"utf8")).version,
    notes:notesFile&&existsSync(notesFile)?readFileSync(notesFile,"utf8").trim():`AI Local Hub ${tag}`,
    pubDate:new Date().toISOString(),
  });
  writeFileSync(out,JSON.stringify(manifest,null,2)+"\n");
  console.log(`Wrote ${out} for ${manifest.version}: ${Object.keys(manifest.platforms).sort().join(", ")}`);
}

if(process.argv[1]===fileURLToPath(import.meta.url))main();
