import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 25_000;

/** Server-sent events fan-out to every connected UI tab. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.write(": ping\n\n"), HEARTBEAT_MS);
    this.timer.unref();
  }

  add(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 2000\n\n");
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  broadcast(event: unknown): void {
    this.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  closeAll(): void {
    clearInterval(this.timer);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private write(text: string): void {
    for (const client of this.clients) client.write(text);
  }
}
