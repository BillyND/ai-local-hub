// Prepares everything the Tauri bundle embeds, for one target:
//   desktop/src-tauri/binaries/wtm-bun-<triple>[.exe]  the Bun runtime (sidecar)
//   desktop/src-tauri/resources/app/                   package.json + dist/ (manager, worker, UI)
//
// Usage: node scripts/stage-desktop.mjs [--target <rust-triple>] [--skip-stale-check]   (default: host, or
// TAURI_ENV_TARGET_TRIPLE). Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// Pinned: this is the Bun version the manager and workers were verified against.
const BUN_VERSION = "1.4.3";
const BUN_ASSETS = {
  "aarch64-apple-darwin": "bun-darwin-aarch64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-aarch64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};
const APP_FILES = ["app.mjs", "worker.mjs", "image-resize-worker.js", "photon_rs_bg.wasm"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "desktop");

function hostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host: (\S+)/m.exec(output);
  if (!match) throw new Error("Cannot determine the host target; pass --target <triple>.");
  return match[1];
}

function targetTriple() {
  const flag = process.argv.indexOf("--target");
  return (flag >= 0 ? process.argv[flag + 1] : undefined) || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads (once, cached) and checksum-verifies the Bun release zip for `asset`. */
async function fetchBunZip(asset) {
  const cache = join(desktop, ".cache", `bun-${BUN_VERSION}`);
  mkdirSync(cache, { recursive: true });
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}`;
  const sums = join(cache, "SHASUMS256.txt");
  if (!existsSync(sums)) writeFileSync(sums, await download(`${base}/SHASUMS256.txt`));
  const line = readFileSync(sums, "utf8").split("\n").find((l) => l.trim().endsWith(`  ${asset}.zip`));
  const expected = line?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum published for ${asset}.zip`);
  const zip = join(cache, `${asset}.zip`);
  if (!existsSync(zip) || sha256(readFileSync(zip)) !== expected) {
    const bytes = await download(`${base}/${asset}.zip`);
    if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch for ${asset}.zip; refusing to use it.`);
    writeFileSync(zip, bytes);
  }
  return readFileSync(zip);
}

async function stageRuntime(triple) {
  const asset = BUN_ASSETS[triple];
  if (!asset) throw new Error(`Unsupported target ${triple}. Supported: ${Object.keys(BUN_ASSETS).join(", ")}`);
  const windows = triple.includes("windows");
  const entries = unzipSync(new Uint8Array(await fetchBunZip(asset)));
  const name = Object.keys(entries).find((key) => key === `${asset}/${windows ? "bun.exe" : "bun"}`);
  if (!name) throw new Error(`The bun executable was not found inside ${asset}.zip`);
  const binaries = join(desktop, "src-tauri", "binaries");
  mkdirSync(binaries, { recursive: true });
  const output = join(binaries, `wtm-bun-${triple}${windows ? ".exe" : ""}`);
  writeFileSync(output, entries[name]);
  chmodSync(output, 0o755);
  return output;
}

/** Newest modification time under `path` (a file or a directory tree, skipping node_modules). */
function newestMtime(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return readdirSync(path)
    .filter((name) => name !== "node_modules")
    .reduce((newest, name) => Math.max(newest, newestMtime(join(path, name))), stats.mtimeMs);
}

function stageApp() {
  const dist = join(root, "dist");
  for (const file of [...APP_FILES, "web/index.html"])
    if (!existsSync(join(dist, file))) throw new Error(`dist/${file} is missing. Run npm run build first.`);
  // Staging a stale build would silently ship old code; refuse instead (modification times are
  // compared, so pass --skip-stale-check if a checkout or cache restore skews them).
  const sources = ["src", "web/src", "web/public", "web/index.html", "scripts/bundle.mjs", "package.json"].map((p) => join(root, p));
  const built = Math.min(statSync(join(dist, "app.mjs")).mtimeMs, statSync(join(dist, "web", "index.html")).mtimeMs);
  const changed = process.argv.includes("--skip-stale-check")
    ? undefined
    : sources.find((source) => existsSync(source) && newestMtime(source) > built);
  if (changed) throw new Error(`dist/ is older than ${changed.slice(root.length + 1)}. Run npm run build first.`);
  const target = join(desktop, "src-tauri", "resources", "app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "dist"), { recursive: true });
  for (const file of APP_FILES) cpSync(join(dist, file), join(target, "dist", file));
  cpSync(join(dist, "web"), join(target, "dist", "web"), { recursive: true });
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // app.mjs reads ../package.json for its version and needs "type": "module" for the .js worker.
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ name: "workspace-tools-mcp", version, private: true, type: "module" }, null, 2)}\n`);
  return target;
}

const triple = targetTriple();
console.log(`Staging desktop resources for ${triple} (Bun ${BUN_VERSION})`);
console.log(`  runtime: ${await stageRuntime(triple)}`);
console.log(`  app:     ${stageApp()}`);
