import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  stop(): Promise<void>;
}

const TERM_GRACE_MS = 2_000;

function redactChunker(
  secrets: readonly string[] | undefined,
  onLog: ((message: string) => void) | undefined,
) {
  const values = (secrets ?? []).filter((value) => value.length > 0);
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const emit = (chunk: Buffer | string): void => {
    if (!onLog) return;
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let completeEnd = 0;
    for (const secret of values) {
      const index = pending.lastIndexOf(secret);
      if (index >= 0)
        completeEnd = Math.max(completeEnd, index + secret.length);
    }
    const completed = pending.slice(0, completeEnd);
    const remainder = pending.slice(completeEnd);
    let safeLength = remainder.length;
    for (const secret of values) {
      for (
        let length = Math.min(secret.length - 1, remainder.length);
        length > 0;
        length -= 1
      ) {
        if (secret.startsWith(remainder.slice(-length))) {
          safeLength = Math.min(safeLength, remainder.length - length);
          break;
        }
      }
    }
    const safe = remainder.slice(0, safeLength);
    pending = remainder.slice(safeLength);
    if (completed || safe) onLog(redact(completed + safe, values));
  };
  const flush = (): void => {
    if (!onLog) return;
    pending += decoder.end();
    onLog(redact(pending, values));
    pending = "";
  };
  return { emit, flush };
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    result = result.split(secret).join("[REDACTED]");
  return result;
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") return;
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

export function spawnManaged(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    onLog?: (message: string) => void;
    secrets?: readonly string[];
  } = {},
): ManagedProcess {
  const child = spawn(command, [...args], {
    env: options.env,
    cwd: options.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid ?? -1;
  const stdoutChunker = redactChunker(options.secrets, options.onLog);
  const stderrChunker = redactChunker(options.secrets, options.onLog);
  child.stdout?.on("data", stdoutChunker.emit);
  child.stderr?.on("data", stderrChunker.emit);

  let settled = false;
  const { promise: exited, resolve: resolveExit } =
    Promise.withResolvers<ProcessExit>();
  // A child can emit error before close (including ENOENT), and close can follow.
  child.once("error", (error) => {
    stdoutChunker.flush();
    stderrChunker.flush();
    if (!settled) {
      settled = true;
      resolveExit({ code: null, signal: null });
    }
    options.onLog?.(`process failed to start: ${error.message}`);
  });
  child.once("close", (code, signal) => {
    stdoutChunker.flush();
    stderrChunker.flush();
    if (!settled) {
      settled = true;
      resolveExit({ code, signal });
    }
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (process.platform === "win32") {
        if (!settled) await killWindowsTree(pid);
        await waitForExit(exited, TERM_GRACE_MS);
        if (!settled)
          throw new Error(
            `Managed process ${pid} did not exit after taskkill.`,
          );
        return;
      }
      if (pid <= 0 || settled) return;
      try {
        signalGroup(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await waitForExit(exited, TERM_GRACE_MS);
      if (settled) return;
      try {
        signalGroup(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await exited;
    })();
    return stopPromise;
  };

  return { pid, exited, stop };
}

async function waitForExit(
  exited: Promise<ProcessExit>,
  milliseconds: number,
): Promise<void> {
  const { promise: timeout, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, milliseconds);
  try {
    await Promise.race([exited.then(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function killWindowsTree(pid: number): Promise<void> {
  if (pid <= 0) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => resolve());
  killer.once("close", () => resolve());
  await promise;
}
