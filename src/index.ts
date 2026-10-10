import { intro, log as cliLog, note, outro, spinner } from "@clack/prompts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveConfig } from "./config.js";
import { startMcpServer, type McpHandle } from "./mcp-server.js";
import { ensureTunnelClient } from "./tunnel-download.js";
import { startTunnel, type TunnelHandle } from "./tunnel-client.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    "local-only": { type: "boolean" },
    reset: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`Usage: npm start [-- --local-only | --reset]

Workspace Tools MCP — local coding tools for ChatGPT and MCP clients.
First run asks for Workspace folder, OpenAI Tunnel ID and OpenAI API key.
Saved privately in ~/.config/workspace-tools-mcp/config.json (permissions 600).
Environment overrides saved settings: WORKSPACE_ROOT, OPENAI_TUNNEL_ID, OPENAI_API_KEY.
--reset       Delete saved settings and run setup again.
--local-only  Start loopback MCP without an OpenAI tunnel.
WORKSPACE_TOOLS_CACHE_DIR defaults to ~/.cache/workspace-tools-mcp.
WORKSPACE_TOOLS_CONFIG_FILE overrides the configuration file location.`);
    return;
  }
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const controller = new AbortController();
  let mcp: McpHandle | undefined;
  let tunnel: TunnelHandle | undefined;
  let runtimeDir: string | undefined;
  let apiKey = "";
  const redact = (message: string): string => apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  const log = (message: string): void => {
    if (interactive) cliLog.info(redact(message));
    else process.stderr.write(`[workspace-tools-mcp] ${redact(message)}\n`);
  };
  const progress = interactive ? spinner() : undefined;
  const stop = (): void => {
    controller.abort(new Error("Shutdown requested."));
    void tunnel?.stop().catch(() => undefined);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const stopped = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    if (interactive) intro("Workspace Tools MCP");
    const config = await resolveConfig({
      localOnly: values["local-only"] ?? false,
      reset: values.reset ?? false,
      signal: controller.signal,
    });
    apiKey = config.apiKey;
    // The tunnel receives its key explicitly; shell tools must not inherit it.
    delete process.env.OPENAI_API_KEY;
    log(`${config.loadedFromDisk ? "Reusing" : "Saved"} configuration: ${config.configPath}`);
    log("Full filesystem and shell permissions enabled; the workspace is not a sandbox.");
    log(`Workspace: ${config.workspaceRoot}`);
    log(`Cache: ${config.cacheDir}`);
    mcp = await startMcpServer(config.workspaceRoot);
    log(`MCP ready: ${mcp.url}`);
    log(`Tools: ${mcp.tools.join(", ")}`);
    controller.signal.throwIfAborted();
    if (config.localOnly) {
      log("Local-only mode. Press Ctrl+C to stop.");
      await stopped;
      return;
    }
    progress?.start("Preparing OpenAI tunnel client");
    const binary = await ensureTunnelClient(config.cacheDir, log, controller.signal);
    progress?.stop(`Tunnel client ${binary.version} ${binary.cached ? "(cached)" : "(downloaded)"}`);
    await mkdir(join(config.cacheDir, "runtime"), { recursive: true, mode: 0o700 });
    runtimeDir = await mkdtemp(join(config.cacheDir, "runtime", "workspace-tools-mcp-"));
    log(`Tunnel profile: ${join(runtimeDir, "workspace-tools-mcp.yaml")}`);
    progress?.start("Connecting OpenAI tunnel");
    tunnel = await startTunnel({ binaryPath: binary.path, runtimeDir, tunnelId: config.tunnelId, apiKey, mcpUrl: mcp.url, onLog: log, signal: controller.signal });
    progress?.stop("OpenAI tunnel ready");
    log(`Tunnel ready: ${tunnel.healthUrl}`);
    const instructions = "https://chatgpt.com/plugins → Add custom MCP server → Tunnel\nKeep this terminal running. Press Ctrl+C to stop.\nRun npm start -- --reset to replace saved settings.";
    if (interactive) note(instructions, "Connect ChatGPT"); else log(instructions);
    const exit = await Promise.race([tunnel.exited, stopped.then(() => undefined)]);
    if (exit && !controller.signal.aborted) throw new Error(`tunnel-client exited (code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"}).`);
  } catch (error: unknown) {
    progress?.stop("Startup stopped");
    if (!controller.signal.aborted) {
      log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    controller.abort(new Error("App stopped."));
    await tunnel?.stop();
    await mcp?.close();
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (interactive) outro("Workspace Tools MCP stopped.");
  }
}

void main().catch(() => {
  // Never print unredacted errors from cleanup or third-party code.
  process.stderr.write("[workspace-tools-mcp] Shutdown failed.\n");
  process.exitCode = 1;
});
