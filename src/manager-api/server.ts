import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import type { InstanceManager } from "../instance-manager.js";
import { handleApi } from "./api.js";
import {
  isAllowedHost,
  isSameOrigin,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  tokensEqual,
} from "./auth.js";
import { EventHub } from "./events.js";
import { HttpError, sendJson } from "./http-utils.js";
import { SECURITY_HEADERS, serveStatic } from "./static-files.js";

export interface WebServerOptions {
  manager: InstanceManager;
  configPath: string;
  localOnly: boolean;
  staticDir: string;
  token: string;
  version: string;
  /** Preferred port; 0 picks a free one. When `strict` is false a busy port falls back to 0. */
  port: number;
  strict: boolean;
  onShutdownRequested(): void;
}

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function listen(server: Server, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    server.removeListener("error", reject);
    resolve();
  });
  return promise;
}

/** Loopback-only HTTP server for the manager UI: cookie-gated API, SSE events and static files. */
export async function startWebServer(
  options: WebServerOptions,
): Promise<WebServer> {
  const { manager, configPath, token } = options;
  const hub = new EventHub();
  let port = 0;
  const lastStatus = new Map<string, string>();
  const onChange = (id: string): void => {
    const status = manager.status(id);
    const serialized = JSON.stringify(status);
    if (lastStatus.get(id) === serialized) return;
    lastStatus.set(id, serialized);
    hub.broadcast({ type: "status", id, status });
  };
  const onLog = (id: string, line: string): void =>
    hub.broadcast({ type: "log", id, line });
  manager.on("change", onChange);
  manager.on("log", onLog);

  const deny = (
    response: ServerResponse,
    status: number,
    message: string,
  ): void => {
    response
      .writeHead(status, {
        ...SECURITY_HEADERS,
        "content-type": "text/plain; charset=utf-8",
      })
      .end(message);
  };

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!isAllowedHost(request.headers.host, port))
      return deny(response, 403, "Forbidden host.");
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const supplied = url.searchParams.get("token");
    if (supplied !== null && tokensEqual(supplied, token)) {
      url.searchParams.delete("token");
      response
        .writeHead(302, {
          "set-cookie": sessionCookie(token),
          location: url.pathname + url.search,
          "cache-control": "no-store",
        })
        .end();
      return;
    }
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!cookie || !tokensEqual(cookie, token))
      return deny(
        response,
        401,
        "Not authorized. Open the link printed by npm start in the terminal.",
      );
    const method = request.method ?? "GET";
    if (MUTATING.has(method) && !isSameOrigin(request.headers.origin, port))
      return deny(response, 403, "Cross-origin request blocked.");
    if (url.pathname.startsWith("/api/")) {
      try {
        await handleApi(request, response, url, {
          manager,
          configPath,
          hub,
          localOnly: options.localOnly,
          version: options.version,
          homeDir: homedir(),
          requestShutdown: options.onShutdownRequested,
        });
      } catch (error: unknown) {
        if (response.headersSent) return void response.end();
        if (error instanceof HttpError)
          return sendJson(response, error.status, { error: error.message });
        sendJson(response, 500, { error: "Internal error." });
      }
      return;
    }
    if (method !== "GET" && method !== "HEAD")
      return deny(response, 405, "Method not allowed.");
    await serveStatic(options.staticDir, url.pathname, response);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) deny(response, 500, "Internal error.");
      else response.end();
    });
  });
  try {
    await listen(server, options.port);
  } catch (error: unknown) {
    if (
      options.strict ||
      (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
    )
      throw error;
    await listen(server, 0);
  }
  port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    async close(): Promise<void> {
      manager.removeListener("change", onChange);
      manager.removeListener("log", onLog);
      hub.closeAll();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
