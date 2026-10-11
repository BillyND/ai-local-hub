import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  spawnManaged,
  type ManagedProcess,
  type ProcessExit,
} from "./process-supervisor.js";

export interface TunnelOptions {
  binaryPath: string;
  runtimeDir: string;
  tunnelId: string;
  apiKey: string;
  mcpUrl: string;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
}
export interface TunnelHandle {
  healthUrl: string;
  profile: string;
  exited: Promise<ProcessExit>;
  stop(): Promise<void>;
}

const STARTUP_MS = 30_000;
const INIT_MS = 15_000;
const PROFILE = "ai-local-hub";

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Tunnel startup aborted");
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
function safeEnv(apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "ComSpec",
  ];
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The official tunnel-client sample/profile contract uses this name internally.
  env.CONTROL_PLANE_API_KEY = apiKey;
  return env;
}
function logProcessFailure(label: string, exit: ProcessExit): Error {
  return new Error(
    `${label} exited unexpectedly (code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"})`,
  );
}

export async function startTunnel(
  options: TunnelOptions,
): Promise<TunnelHandle> {
  checkAbort(options.signal);
  await mkdir(options.runtimeDir, { recursive: true });
  const profile = PROFILE;
  const env = safeEnv(options.apiKey);
  const init = spawnManaged(
    options.binaryPath,
    [
      "init",
      "--profile-dir",
      options.runtimeDir,
      "--profile",
      profile,
      "--sample",
      "sample_mcp_remote_no_auth",
      "--mcp-server-url",
      options.mcpUrl,
      "--tunnel-id",
      options.tunnelId,
      "--health-listen-addr",
      "127.0.0.1:0",
      "--force",
    ],
    { env, onLog: options.onLog, secrets: [options.apiKey] },
  );
  const initTimer = setTimeout(() => {
    void init.stop();
  }, INIT_MS);
  try {
    const exit = await raceAbort(init.exited, options.signal);
    if (exit.code !== 0 || exit.signal !== null)
      throw logProcessFailure("tunnel-client init", exit);
  } catch (error) {
    await init.stop();
    await rm(options.runtimeDir, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(initTimer);
  }

  checkAbort(options.signal);
  const healthFile = join(options.runtimeDir, "health.url");
  const run = spawnManaged(
    options.binaryPath,
    [
      "run",
      "--profile-dir",
      options.runtimeDir,
      "--profile",
      profile,
      "--control-plane.api-key",
      "env:CONTROL_PLANE_API_KEY",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      healthFile,
    ],
    { env, onLog: options.onLog, secrets: [options.apiKey] },
  );
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopPromise) stopPromise = run.stop();
    return stopPromise;
  };
  try {
    const healthUrl = await waitForReady(healthFile, run, options.signal);
    return { healthUrl, profile, exited: run.exited, stop };
  } catch (error) {
    await stop();
    await rm(options.runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => {
    signal.removeEventListener("abort", onAbort);
    reject(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    },
  );
  return await result;
}

async function waitForReady(
  healthFile: string,
  process: ManagedProcess,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + STARTUP_MS;
  let lastDiagnostic = "health URL not written";
  while (Date.now() < deadline) {
    checkAbort(signal);
    const outcome = await Promise.race([
      process.exited.then((exit) => ({ kind: "exit" as const, exit })),
      sleep(100).then(() => ({ kind: "wait" as const })),
    ]);
    if (outcome.kind === "exit")
      throw logProcessFailure("tunnel-client run", outcome.exit);
    try {
      const url = (await readFile(healthFile, "utf8"))
        .trim()
        .replace(/\/$/, "");
      if (url) {
        const health = await fetch(`${url}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!health.ok) {
          lastDiagnostic = `/healthz returned HTTP ${health.status}`;
        } else {
          const ready = await fetch(`${url}/readyz`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (ready.ok) return url;
          lastDiagnostic = `/readyz returned HTTP ${ready.status}`;
        }
      }
    } catch (error) {
      lastDiagnostic = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(
    `Tunnel readiness timed out after ${STARTUP_MS}ms: ${lastDiagnostic}`,
  );
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
