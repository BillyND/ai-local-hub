// Bundles the manager and the worker into dist/chatgpt-local-tools.mjs and dist/chatgpt-local-tools-worker.mjs.
//
// Why: loading the whole Pi SDK costs ~95 MB of RSS per process (AI providers, TUI, syntax
// highlighting, image codecs...). The worker only needs Pi's tool factories, so its bundle
// aliases the package root to the tools module and drops the rest; the manager does not
// import Pi at all.
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTools = join(dirname(piRoot), "core", "tools", "index.js");
if (!existsSync(piTools))
  throw new Error(`Pi tools module not found at ${piTools}; the pinned @earendil-works/pi-coding-agent layout changed.`);

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  // CommonJS dependencies call require() and use __dirname (Photon reads its .wasm next to itself);
  // provide both in the ESM output. __dirname is the dist directory, where the .wasm is copied.
  banner: {
    js: "import{createRequire as __r}from'node:module';import{fileURLToPath as __u}from'node:url';import{dirname as __d}from'node:path';const require=__r(import.meta.url);const __filename=__u(import.meta.url);const __dirname=__d(__filename);",
  },
};

await build({ ...common, entryPoints: { "chatgpt-local-tools": "src/index.ts" } });
await build({
  ...common,
  entryPoints: { "chatgpt-local-tools-worker": "src/worker-main.ts" },
  alias: { "@earendil-works/pi-coding-agent": piTools },
});

// Pi resizes images in a worker thread loaded from ./image-resize-worker.js next to the module
// that spawns it, so the worker bundle needs that exact file name beside it in dist/.
await build({
  ...common,
  entryPoints: [join(dirname(piRoot), "utils", "image-resize-worker.js")],
  outdir: undefined,
  outExtension: undefined,
  outfile: join(root, "dist", "image-resize-worker.js"),
});
const photonDir = dirname(createRequire(piRoot).resolve("@silvia-odwyer/photon-node/package.json"));
copyFileSync(join(photonDir, "photon_rs_bg.wasm"), join(root, "dist", "photon_rs_bg.wasm"));
