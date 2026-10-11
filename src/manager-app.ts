import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstanceManager } from "./instance-manager.js";
import { acquireManagerLock } from "./manager-lock.js";
import { newToken } from "./manager-api/auth.js";
import { startWebServer } from "./manager-api/server.js";
import { openBrowser } from "./open-browser.js";
import { readPackageVersion } from "./version.js";

export interface ManagerAppOptions {
  manager: InstanceManager;
  configPath: string;
  localOnly: boolean;
  /** Preferred UI port; `explicitPort` makes a busy port an error instead of falling back. */
  port: number;
  explicitPort: boolean;
  open: boolean;
  staticDir?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Compiled: dist/web next to dist/manager-app.js. From source (tsx): the built dist/web.
const DEFAULT_STATIC_DIR = existsSync(join(HERE, "web", "index.html"))
  ? join(HERE, "web")
  : join(HERE, "..", "dist", "web");

/** Serves the web UI and keeps the manager alive until Ctrl+C or the UI's Quit button. */
export async function runManagerApp(
  options: ManagerAppOptions,
): Promise<number> {
  const { manager } = options;
  const token = newToken();
  const { promise: stopRequested, resolve: requestStop } =
    Promise.withResolvers<void>();
  const server = await startWebServer({
    manager,
    configPath: options.configPath,
    localOnly: options.localOnly,
    staticDir: options.staticDir ?? DEFAULT_STATIC_DIR,
    token,
    version: await readPackageVersion(),
    port: options.port,
    strict: options.explicitPort,
    onShutdownRequested: requestStop,
  });
  const lock = await acquireManagerLock(
    join(dirname(options.configPath), "manager.lock"),
    {
      pid: process.pid,
      url: server.url,
      token,
    },
  );
  if (!lock.acquired) {
    await server.close();
    const existing = `${lock.existing.url}?token=${lock.existing.token}`;
    console.log(
      `Workspace Tools MCP is already running (pid ${lock.existing.pid}).\nOpen: ${existing}`,
    );
    if (options.open) openBrowser(existing);
    return 0;
  }
  const link = `${server.url}?token=${token}`;
  console.log(
    `Workspace Tools MCP is running.\nOpen: ${link}\nPress Ctrl+C to stop all instances and quit.`,
  );
  if (options.open) openBrowser(link);
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  await stopRequested;
  console.log("Stopping instances…");
  await manager.stopAll();
  await server.close();
  await lock.release();
  return 0;
}
