import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import { startMcpServer, type McpHandle } from './mcp-server.js';
import { ensureTunnelClient } from './tunnel-download.js';
import { startTunnel, type TunnelHandle } from './tunnel-client.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, 'local-only': { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: npm start [-- --local-only]\nPrompts for WORKSPACE_ROOT, CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY.\nEnvironment values take precedence. --local-only starts MCP without a tunnel for diagnostics.\nPI_TOOLS_MCP_CACHE_DIR defaults to ~/.cache/pi-tools-mcp.');
    return;
  }
  const controller = new AbortController();
  let mcp: McpHandle | undefined;
  let tunnel: TunnelHandle | undefined;
  let runtimeDir: string | undefined;
  let apiKey = '';
  const log = (message: string): void => {
    process.stderr.write(`[pi-tools-mcp] ${apiKey ? message.split(apiKey).join('[REDACTED]') : message}\n`);
  };
  const stop = (): void => {
    controller.abort(new Error('Shutdown requested.'));
    void tunnel?.stop().catch(() => undefined);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const stopped = new Promise<void>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    const config = await resolveConfig({ localOnly: values['local-only'] ?? false, signal: controller.signal });
    apiKey = config.apiKey;
    // Keep the tunnel key out of shell tool environments. The tunnel receives it explicitly.
    delete process.env.CONTROL_PLANE_API_KEY;
    log('Full filesystem and shell permissions enabled; WORKSPACE_ROOT is not a sandbox.');
    log(`workspace: ${config.workspaceRoot}`);
    log(`cache: ${config.cacheDir}`);
    mcp = await startMcpServer(config.workspaceRoot);
    log(`MCP ready: ${mcp.url}`);
    log(`tools: ${mcp.tools.join(', ')}`);
    controller.signal.throwIfAborted();
    if (config.localOnly) {
      log('Local-only mode: OpenAI tunnel disabled.');
      await stopped;
      return;
    }
    const binary = await ensureTunnelClient(config.cacheDir, log, controller.signal);
    log(`tunnel-client ${binary.version} ${binary.cached ? '(cache hit)' : '(downloaded)'}`);
    await mkdir(join(config.cacheDir, 'runtime'), { recursive: true, mode: 0o700 });
    runtimeDir = await mkdtemp(join(config.cacheDir, 'runtime', 'pi-tools-mcp-'));
    log(`tunnel profile: ${join(runtimeDir, 'pi-tools-mcp.yaml')}`);
    tunnel = await startTunnel({ binaryPath: binary.path, runtimeDir, tunnelId: config.tunnelId,
      apiKey, mcpUrl: mcp.url, onLog: log, signal: controller.signal });
    log(`tunnel ready: ${tunnel.healthUrl}`);
    log('Connect in https://chatgpt.com/plugins → Add custom MCP server → Tunnel.');
    const exit = await Promise.race([tunnel.exited, stopped.then(() => undefined)]);
    if (exit && !controller.signal.aborted) {
      throw new Error(`tunnel-client exited (code=${exit.code ?? 'none'}, signal=${exit.signal ?? 'none'}).`);
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    controller.abort(new Error('App stopped.'));
    await tunnel?.stop();
    await mcp?.close();
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch(() => {
  // Never print unredacted errors from cleanup or third-party code.
  process.stderr.write('[pi-tools-mcp] Shutdown failed.\n');
  process.exitCode = 1;
});
