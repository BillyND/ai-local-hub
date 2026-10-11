import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { InstanceConfig } from "./config.js";
import { signalGroup } from "./process-supervisor.js";
import { resolveWorkerScript } from "./worker-script.js";
import { parseEvent, type WorkerEvent } from "./worker-protocol.js";

export type InstanceState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface InstanceStatus {
  state: InstanceState;
  phase?: string;
  url?: string;
  tunnelReady: boolean;
  error?: string;
}

export interface InstanceManagerOptions {
  cacheDir: string;
  localOnly: boolean;
  /** Worker entry script; defaults to the one built next to the manager. */
  entryScript?: string;
  /** Resolves the tunnel client path once; the result is shared by all workers. */
  tunnelBinary?: (log: (message: string) => void) => Promise<string>;
}

const MAX_LOG_LINES = 1_000;
// Longer than the tunnel client's own stop grace, so the worker can clean up its child.
const GRACEFUL_MS = 10_000;
const TERM_MS = 3_000;

interface Entry {
  status: InstanceStatus;
  logs: string[];
  child?: ChildProcess;
  exited?: Promise<void>;
  stopRequested: boolean;
  /** Bumped by every start and stop so a start awaiting the download can tell it was superseded. */
  generation: number;
}

/** Owns one worker process per instance and exposes state and logs; emits "change" with the id. */
export class InstanceManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private tunnelBinary: Promise<string> | undefined;

  constructor(private readonly options: InstanceManagerOptions) {
    super();
  }

  status(id: string): InstanceStatus {
    return { ...this.entry(id).status };
  }

  logs(id: string): readonly string[] {
    return this.entry(id).logs;
  }

  /** True while a worker may still be alive, even after it reported a fatal error. */
  isActive(id: string): boolean {
    const entry = this.entry(id);
    return (
      Boolean(entry.child) ||
      (entry.status.state !== "stopped" && entry.status.state !== "error")
    );
  }

  async start(instance: InstanceConfig): Promise<void> {
    const entry = this.entry(instance.id);
    if (this.isActive(instance.id)) return;
    entry.stopRequested = false;
    const generation = ++entry.generation;
    entry.status = {
      state: "starting",
      phase: "Starting worker",
      tunnelReady: false,
    };
    entry.logs.length = 0;
    this.emit("change", instance.id);
    const log = (message: string): void => this.addLog(instance, message);
    let binary: string | undefined;
    if (!this.options.localOnly) {
      try {
        entry.status.phase = "Preparing tunnel client";
        this.emit("change", instance.id);
        binary = await this.resolveTunnelBinary(log);
      } catch (error: unknown) {
        if (entry.generation === generation)
          this.fail(
            instance.id,
            error instanceof Error ? error.message : String(error),
          );
        return;
      }
      if (entry.generation !== generation) return;
    }
    this.spawnWorker(instance, entry, binary);
  }

  async stop(id: string): Promise<void> {
    const entry = this.entry(id);
    entry.stopRequested = true;
    entry.generation += 1;
    if (!entry.child) {
      if (entry.status.state === "starting") this.finish(id, "stopped");
      return;
    }
    entry.status = { ...entry.status, state: "stopping", phase: "Stopping" };
    this.emit("change", id);
    const child = entry.child;
    child.stdin?.end();
    const timers: NodeJS.Timeout[] = [];
    const escalate = (delay: number, signal: NodeJS.Signals): void => {
      timers.push(
        setTimeout(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null)
            this.terminate(child, signal);
        }, delay),
      );
    };
    escalate(GRACEFUL_MS, "SIGTERM");
    escalate(GRACEFUL_MS + TERM_MS, "SIGKILL");
    try {
      await entry.exited;
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        status: { state: "stopped", tunnelReady: false },
        logs: [],
        stopRequested: false,
        generation: 0,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private resolveTunnelBinary(log: (message: string) => void): Promise<string> {
    const resolver = this.options.tunnelBinary;
    if (!resolver)
      return Promise.reject(new Error("No tunnel client resolver configured."));
    this.tunnelBinary ??= resolver(log).catch((error: unknown) => {
      this.tunnelBinary = undefined;
      throw error;
    });
    return this.tunnelBinary;
  }

  private spawnWorker(
    instance: InstanceConfig,
    entry: Entry,
    binary?: string,
  ): void {
    let script: string;
    try {
      script = this.options.entryScript ?? resolveWorkerScript();
    } catch (error: unknown) {
      return this.fail(instance.id, error instanceof Error ? error.message : String(error));
    }
    const args = [
      ...process.execArgv,
      script,
      ...(this.options.localOnly ? ["--local-only"] : []),
    ];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        WORKSPACE_ROOT: instance.workspaceRoot,
        OPENAI_TUNNEL_ID: instance.tunnelId,
        OPENAI_API_KEY: instance.apiKey,
        WORKSPACE_TOOLS_CACHE_DIR: this.options.cacheDir,
        ...(binary ? { WORKSPACE_TOOLS_TUNNEL_BIN: binary } : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    entry.child = child;
    const redact = (line: string): string =>
      instance.apiKey ? line.split(instance.apiKey).join("[REDACTED]") : line;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = parseEvent(line);
      if (event) this.apply(instance, event);
      else this.addLog(instance, redact(line));
    });
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.addLog(instance, redact(line)),
    );
    // A failed spawn emits "error" (maybe without "exit"); "close" always follows once streams end.
    child.on("error", (error) =>
      this.addLog(instance, `worker failed to start: ${error.message}`),
    );
    entry.exited = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        entry.child = undefined;
        const failed = !entry.stopRequested && entry.status.state !== "error";
        if (failed)
          this.fail(
            instance.id,
            `Worker exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
          );
        else if (entry.status.state !== "error")
          this.finish(instance.id, "stopped");
        resolve();
      });
    });
  }

  private apply(instance: InstanceConfig, event: WorkerEvent): void {
    const entry = this.entry(instance.id);
    if (entry.stopRequested && event.type !== "log" && event.type !== "fatal")
      return;
    switch (event.type) {
      case "log":
        return this.addLog(instance, event.message);
      case "phase":
        entry.status = { ...entry.status, phase: event.message };
        break;
      case "mcp":
        entry.status = { ...entry.status, url: event.url };
        break;
      case "ready":
        entry.status = {
          ...entry.status,
          state: "running",
          phase: undefined,
          tunnelReady: event.tunnel,
        };
        break;
      case "fatal":
        return this.fail(instance.id, event.message);
    }
    this.emit("change", instance.id);
  }

  private addLog(instance: InstanceConfig, message: string): void {
    const logs = this.entry(instance.id).logs;
    logs.push(message);
    if (logs.length > MAX_LOG_LINES)
      logs.splice(0, logs.length - MAX_LOG_LINES);
    this.emit("log", instance.id, message);
    this.emit("change", instance.id);
  }

  private fail(id: string, message: string): void {
    this.entry(id).status = {
      state: "error",
      tunnelReady: false,
      error: message,
    };
    this.emit("change", id);
  }

  private finish(id: string, state: "stopped"): void {
    this.entry(id).status = { state, tunnelReady: false };
    this.emit("change", id);
  }

  private terminate(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform === "win32" || !child.pid) child.kill(signal);
      else signalGroup(child.pid, signal);
    } catch {
      /* already gone */
    }
  }
}
