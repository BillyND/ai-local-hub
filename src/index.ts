import { parseArgs } from "node:util";
import {
  loadConfig,
  removeSavedConfig,
  resolveCacheDir,
  resolveConfigPath,
} from "./config.js";
import { runHeadless } from "./headless.js";
import { InstanceManager } from "./instance-manager.js";
import { runManagerApp } from "./manager-app.js";
import { ensureTunnelClient } from "./tunnel-download.js";

const DEFAULT_PORT = 4747;

const HELP = `Usage: npm start [-- --port <n> | --no-open | --local-only | --headless | --instance <name> | --reset]

Workspace Tools MCP — local coding tools for ChatGPT and MCP clients.
Starts a manager with a local web UI (opened in your browser) where each instance has its
own Tunnel ID, API key and workspace and runs as its own process. Settings are saved
privately in ~/.config/workspace-tools-mcp/config.json (permissions 600).
--port <n>        Web UI port (default ${DEFAULT_PORT}; a busy default falls back to a free port).
--no-open         Do not open the browser; use the link printed in the terminal.
--desktop         For the desktop app: print a JSON ready line, quit when stdin closes.
--headless        No web UI: start every instance (or those named by --instance) and log to stderr.
                  Use this for services and CI.
--instance <name> Limit --headless to this instance; repeatable.
--local-only      Start loopback MCP servers without OpenAI tunnels.
--reset           Delete saved settings and exit.
WORKSPACE_TOOLS_CACHE_DIR defaults to ~/.cache/workspace-tools-mcp.
WORKSPACE_TOOLS_CONFIG_FILE overrides the configuration file location.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      "local-only": { type: "boolean" },
      headless: { type: "boolean" },
      instance: { type: "string", multiple: true },
      reset: { type: "boolean" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      desktop: { type: "boolean" },
    },
  });
  const localOnly = values["local-only"] ?? false;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const configPath = resolveConfigPath();
  if (values.reset) {
    await removeSavedConfig(configPath);
    console.log(`Removed saved settings: ${configPath}`);
    return 0;
  }
  const saved = await loadConfig(configPath);
  const cacheDir = resolveCacheDir(saved);
  const manager = new InstanceManager({
    cacheDir,
    localOnly,
    tunnelBinary: async (log) => (await ensureTunnelClient(cacheDir, log)).path,
  });
  if (values.headless) {
    const names = (values.instance ?? []).map((name) => name.toLowerCase());
    const unknown = names.filter(
      (name) => !saved.instances.some((o) => o.name.toLowerCase() === name),
    );
    if (unknown.length > 0)
      throw new Error(`Unknown instance: ${unknown.join(", ")}.`);
    const selected = saved.instances.filter(
      (o) => names.length === 0 || names.includes(o.name.toLowerCase()),
    );
    return runHeadless(manager, selected);
  }
  const explicitPort = values.port !== undefined;
  const port = explicitPort ? Number(values.port) : values.desktop ? 0 : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("--port must be 0-65535.");
  return runManagerApp({
    manager,
    configPath,
    localOnly,
    port,
    explicitPort,
    open: !values["no-open"] && !values.desktop,
    desktop: values.desktop ?? false,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Messages come from our own validation; never print raw third-party errors with secrets.
    process.stderr.write(
      `[workspace-tools-mcp] ${error instanceof Error ? error.message : "Failed."}\n`,
    );
    process.exitCode = 1;
  },
);
