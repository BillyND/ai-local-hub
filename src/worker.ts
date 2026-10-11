import { runInstance } from "./instance-runner.js";
import { encodeEvent, type WorkerEvent } from "./worker-protocol.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set for the worker.`);
  return value;
}

/**
 * Worker entry: configuration arrives through the environment (secrets never in argv),
 * events leave as JSON lines on stdout, and closing stdin requests shutdown. Closing
 * stdin also fires when the parent dies, so a worker never outlives its manager.
 */
export async function runWorker(localOnly: boolean): Promise<number> {
  const emit = (event: WorkerEvent): void => {
    process.stdout.write(encodeEvent(event));
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("Shutdown requested."));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
  let apiKey = "";
  try {
    apiKey = localOnly ? "" : required("OPENAI_API_KEY");
    // The tunnel receives its key explicitly; shell tools must not inherit it.
    delete process.env.OPENAI_API_KEY;
    await runInstance({
      workspaceRoot: required("WORKSPACE_ROOT"),
      tunnelId: localOnly ? "" : required("OPENAI_TUNNEL_ID"),
      apiKey,
      cacheDir: required("WORKSPACE_TOOLS_CACHE_DIR"),
      localOnly,
      tunnelBinaryPath:
        process.env.WORKSPACE_TOOLS_TUNNEL_BIN?.trim() || undefined,
      signal: controller.signal,
      emit,
    });
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) return 0;
    const message = error instanceof Error ? error.message : String(error);
    emit({
      type: "fatal",
      message: apiKey ? message.split(apiKey).join("[REDACTED]") : message,
    });
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("close", stop);
    process.stdin.pause();
  }
}
