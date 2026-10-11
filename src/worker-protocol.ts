/** JSON-lines events a worker writes to stdout; the manager parses them. */
export type WorkerEvent =
  | { type: "log"; message: string }
  | { type: "phase"; message: string }
  | { type: "mcp"; url: string }
  | { type: "ready"; tunnel: boolean }
  | { type: "fatal"; message: string };

export function encodeEvent(event: WorkerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Returns undefined for lines that are not protocol events (stray stdout output). */
export function parseEvent(line: string): WorkerEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("type" in value))
    return undefined;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "log":
    case "phase":
    case "fatal":
      return typeof event.message === "string"
        ? { type: event.type, message: event.message }
        : undefined;
    case "mcp":
      return typeof event.url === "string"
        ? { type: "mcp", url: event.url }
        : undefined;
    case "ready":
      return typeof event.tunnel === "boolean"
        ? { type: "ready", tunnel: event.tunnel }
        : undefined;
    default:
      return undefined;
  }
}
