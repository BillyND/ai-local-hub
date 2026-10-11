import { runWorker } from "./worker.js";

// Entry for one instance's worker process. Kept separate from index.ts so the manager
// (web UI only) never loads the heavy tool dependencies.
runWorker(process.argv.includes("--local-only")).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Never print unredacted errors from cleanup or third-party code.
    process.stderr.write("[workspace-tools-mcp] Worker failed.\n");
    process.exitCode = 1;
  },
);
