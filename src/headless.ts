import type { InstanceConfig } from "./config.js";
import type { InstanceManager } from "./instance-manager.js";

/**
 * Starts instances without a TUI and prefixes their logs. Returns when interrupted
 * (SIGINT/SIGTERM) or when every instance has stopped on its own; exit code 1 if any failed.
 */
export async function runHeadless(
  manager: InstanceManager,
  instances: readonly InstanceConfig[],
): Promise<number> {
  const write = (text: string): void => void process.stderr.write(`[workspace-tools-mcp] ${text}\n`);
  if (instances.length === 0) {
    write("No instances to start. Run npm start and add one in the web UI.");
    return 1;
  }
  const nameOf = (id: string): string => instances.find((o) => o.id === id)?.name ?? id;
  const states = new Map<string, string>();
  const { promise: done, resolve } = Promise.withResolvers<void>();
  manager.on("log", (id: string, line: string) => write(`[${nameOf(id)}] ${line}`));
  manager.on("change", (id: string) => {
    const status = manager.status(id);
    const summary = status.error ? `${status.state}: ${status.error}` : status.state;
    if (states.get(id) !== summary) {
      states.set(id, summary);
      write(`[${nameOf(id)}] state: ${summary}`);
    }
    if (instances.every((o) => !manager.isActive(o.id))) resolve();
  });
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
  await Promise.all(instances.map((instance) => manager.start(instance)));
  await done;
  await manager.stopAll();
  return instances.some((o) => manager.status(o.id).state === "error") ? 1 : 0;
}
