import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startMcpServer, type McpHandle } from "./mcp-server.js";
import { startTunnel, type TunnelHandle } from "./tunnel-client.js";
import { ensureTunnelClient } from "./tunnel-download.js";
import type { WorkerEvent } from "./worker-protocol.js";

export interface RunInstanceOptions {
  workspaceRoot: string;
  tunnelId: string;
  apiKey: string;
  cacheDir: string;
  localOnly: boolean;
  /** Pre-downloaded tunnel client; when absent the runner downloads it itself. */
  tunnelBinaryPath?: string;
  signal: AbortSignal;
  emit: (event: WorkerEvent) => void;
}

/** Runs MCP server plus tunnel for one instance until aborted or the tunnel exits. */
export async function runInstance(options: RunInstanceOptions): Promise<void> {
  const { signal, emit, apiKey } = options;
  const redact = (message: string): string =>
    apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  const log = (message: string): void =>
    emit({ type: "log", message: redact(message) });
  const stopped = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let mcp: McpHandle | undefined;
  let tunnel: TunnelHandle | undefined;
  let runtimeDir: string | undefined;
  try {
    log(
      "Full filesystem and shell permissions enabled; the workspace is not a sandbox.",
    );
    log(`Workspace: ${options.workspaceRoot}`);
    emit({ type: "phase", message: "Starting MCP server" });
    mcp = await startMcpServer(options.workspaceRoot);
    emit({ type: "mcp", url: mcp.url });
    log(`MCP ready: ${mcp.url}`);
    log(`Tools: ${mcp.tools.join(", ")}`);
    signal.throwIfAborted();
    if (options.localOnly) {
      emit({ type: "ready", tunnel: false });
      await stopped;
      return;
    }
    emit({ type: "phase", message: "Preparing tunnel client" });
    const binaryPath =
      options.tunnelBinaryPath ??
      (await ensureTunnelClient(options.cacheDir, log, signal)).path;
    await mkdir(join(options.cacheDir, "runtime"), {
      recursive: true,
      mode: 0o700,
    });
    runtimeDir = await mkdtemp(
      join(options.cacheDir, "runtime", "workspace-tools-mcp-"),
    );
    emit({ type: "phase", message: "Connecting tunnel" });
    tunnel = await startTunnel({
      binaryPath,
      runtimeDir,
      tunnelId: options.tunnelId,
      apiKey,
      mcpUrl: mcp.url,
      onLog: log,
      signal,
    });
    log(`Tunnel ready: ${tunnel.healthUrl}`);
    emit({ type: "ready", tunnel: true });
    const exit = await Promise.race([
      tunnel.exited,
      stopped.then(() => undefined),
    ]);
    if (exit && !signal.aborted)
      throw new Error(
        `tunnel-client exited (code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"}).`,
      );
  } finally {
    // Each cleanup step runs even if an earlier one fails; the first failure is rethrown.
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await step();
      } catch (error: unknown) {
        failures.push(error);
      }
    };
    await attempt(() => tunnel?.stop());
    await attempt(() => mcp?.close());
    if (runtimeDir) {
      const dir = runtimeDir;
      await attempt(() => rm(dir, { recursive: true, force: true }));
    }
    if (failures.length > 0) throw failures[0];
  }
}
