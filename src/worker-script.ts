import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  "worker.mjs", // bundled build (npm run build)
  "worker-main.js", // tsc output
  "worker-main.ts", // running from source with tsx
];

/** Locates the worker entry next to the running manager, whichever way it was built. */
export function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of CANDIDATES) {
    const path = join(here, name);
    if (existsSync(path)) return path;
  }
  throw new Error("Cannot locate the worker entry. Run npm run build.");
}
