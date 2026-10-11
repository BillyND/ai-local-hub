import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createPiTools } from "./pi-tools.js";
import { getPiToolNames, registerPiTools } from "./pi-tool-adapter.js";
import { ToolCapacity } from "./tool-capacity.js";
import { readPackageVersion } from "./version.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  controller: AbortController;
  activeResponses: number;
  activeTools: number;
  lastActivity: number;
}

export interface McpServerOptions {
  port?: number;
  maxSessions?: number;
  sessionIdleTimeoutMs?: number;
  maxFileTools?: number;
  maxProcessTools?: number;
  maxQueuedFileTools?: number;
  maxQueuedProcessTools?: number;
}

export interface McpHandle {
  url: string;
  tools: string[];
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024;
const MAX_POST_REQUESTS = 2_048;

class BodyCapacityError extends Error {}

async function readJsonBody(
  request: IncomingMessage,
  reserve: (bytes: number) => void,
  release: (bytes: number) => void,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let reservedSize = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.length > MAX_BODY_BYTES)
        throw new Error("MCP request body exceeds 4 MiB.");
      reserve(bytes.length);
      reservedSize += bytes.length;
      size += bytes.length;
      chunks.push(bytes);
    }
    if (size === 0) return undefined;
    const body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
    return JSON.parse(body.toString("utf8")) as unknown;
  } finally {
    release(reservedSize);
  }
}

function writeError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response
    .writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      ...(status === 429 ? { "Retry-After": "1" } : {}),
    })
    .end(message);
}

export async function startMcpServer(
  workspaceRoot: string,
  portOrOptions: number | McpServerOptions = {},
): Promise<McpHandle> {
  const options =
    typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
  const maxSessions = options.maxSessions ?? 1_024;
  const idleTimeoutMs = options.sessionIdleTimeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
    throw new Error("maxSessions must be a positive safe integer.");
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1)
    throw new Error("sessionIdleTimeoutMs must be a positive safe integer.");
  const capacity = new ToolCapacity(
    options.maxFileTools,
    options.maxProcessTools,
    options.maxQueuedFileTools,
    options.maxQueuedProcessTools,
  );
  const version = await readPackageVersion();
  const tools = createPiTools(workspaceRoot);
  const shutdown = new AbortController();
  const sessions = new Map<string, Session>();
  const requests = new Set<Promise<void>>();
  let pendingSessions = 0;
  let activePosts = 0;
  let bufferedBodyBytes = 0;
  let closing = false;
  const http = createServer((request, response) => {
    const execution = handleRequest(request, response)
      .catch(() => writeError(response, 500, "MCP transport failed"))
      .finally(() => requests.delete(execution));
    requests.add(execution);
  });
  // These apply to receiving requests/idle sockets, not tool execution deadlines.
  http.keepAliveTimeout = 60_000;
  http.headersTimeout = 65_000;
  http.requestTimeout = 300_000;
  http.maxConnections = Math.max(maxSessions * 4, 1_024);

  async function removeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.controller.abort(new Error("MCP session closed."));
    await session.server.close();
  }

  function trackResponse(session: Session, response: ServerResponse): void {
    session.lastActivity = Date.now();
    session.activeResponses += 1;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      response.removeListener("finish", finish);
      response.removeListener("close", finish);
      session.activeResponses -= 1;
      session.lastActivity = Date.now();
    };
    response.once("finish", finish);
    response.once("close", finish);
  }

  async function routeMcp(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sessionId = request.headers["mcp-session-id"];
    const session =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (typeof sessionId === "string" && !session) {
      writeError(response, 404, "MCP session not found.");
      return;
    }
    if (session) {
      trackResponse(session, response);
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (request.method !== "POST") {
      writeError(
        response,
        request.method === "GET" || request.method === "DELETE" ? 400 : 405,
        "MCP session ID is required.",
      );
      return;
    }
    if (!isInitializeRequest(body)) {
      writeError(response, 400, "Missing MCP session.");
      return;
    }
    if (sessions.size + pendingSessions >= maxSessions) {
      writeError(
        response,
        429,
        "MCP session capacity reached. Retry after a session closes.",
      );
      return;
    }
    pendingSessions += 1;
    let reserved = true;
    let createdId: string | undefined;
    let newSession: Session | undefined;
    let server: McpServer | undefined;
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (closing || shutdown.signal.aborted)
            throw new Error("MCP server is shutting down.");
          createdId = id;
          // Publish before initialize returns: subsequent client requests can route immediately.
          sessions.set(id, newSession!);
          pendingSessions -= 1;
          reserved = false;
        },
        onsessionclosed: removeSession,
      });
      server = new McpServer(
        { name: "chatgpt-local-tools", version },
        {
          instructions: `Use these Pi SDK tools directly. Relative paths and shell commands start in ${workspaceRoot}. Full process permissions are enabled; the workspace is not a sandbox. Use read before edit; edit requires exact unique oldText replacements in edits[].`,
        },
      );
      newSession = {
        server,
        transport,
        controller: new AbortController(),
        activeResponses: 0,
        activeTools: 0,
        lastActivity: Date.now(),
      };
      const current = newSession;
      registerPiTools(
        server,
        tools,
        AbortSignal.any([shutdown.signal, current.controller.signal]),
        capacity,
        {
          start: () => {
            current.activeTools += 1;
          },
          finish: () => {
            current.activeTools -= 1;
            current.lastActivity = Date.now();
          },
        },
      );
      await server.connect(transport);
      trackResponse(current, response);
      await transport.handleRequest(request, response, body);
      if (!createdId) await server.close();
    } catch (error) {
      if (createdId) await removeSession(createdId);
      else await server?.close();
      throw error;
    } finally {
      if (reserved) pendingSessions -= 1;
    }
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (closing) {
      writeError(response, 503, "MCP server is shutting down");
      return;
    }
    const host = request.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) {
      writeError(response, 403, "Invalid Host");
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) {
      writeError(response, 403, "Invalid Origin");
      return;
    }
    if (request.url === "/healthz" || request.url === "/readyz") {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"ready":true}');
      return;
    }
    if (request.url !== "/mcp") {
      writeError(response, 404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      await routeMcp(request, response, undefined);
      return;
    }
    if (activePosts >= MAX_POST_REQUESTS) {
      writeError(response, 429, "MCP request capacity reached.");
      return;
    }
    activePosts += 1;
    try {
      let body: unknown;
      try {
        body = await readJsonBody(
          request,
          (bytes) => {
            if (bufferedBodyBytes + bytes > MAX_BUFFERED_BODY_BYTES)
              throw new BodyCapacityError();
            bufferedBodyBytes += bytes;
          },
          (bytes) => {
            bufferedBodyBytes -= bytes;
          },
        );
      } catch (error) {
        writeError(
          response,
          error instanceof BodyCapacityError ? 429 : 400,
          error instanceof BodyCapacityError
            ? "MCP request body capacity reached."
            : error instanceof SyntaxError
              ? "Invalid JSON body"
              : "Invalid MCP request body",
        );
        return;
      }
      await routeMcp(request, response, body);
    } finally {
      activePosts -= 1;
    }
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(
      { port: options.port ?? 0, host: "127.0.0.1", backlog: 2_048 },
      () => {
        http.removeListener("error", reject);
        resolve();
      },
    );
  });
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (
          session.activeResponses === 0 &&
          session.activeTools === 0 &&
          now - session.lastActivity >= idleTimeoutMs
        ) {
          void removeSession(id).catch(() => undefined);
        }
      }
    },
    Math.min(30_000, idleTimeoutMs),
  );
  sweep.unref();
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("MCP listener has no TCP address.");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      clearInterval(sweep);
      shutdown.abort(new Error("MCP server is shutting down."));
      const closed = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      http.closeAllConnections();
      await Promise.allSettled([...sessions.keys()].map(removeSession));
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...requests]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await closed;
    })();
    return closePromise;
  };
  try {
    const health = await fetch(url.replace("/mcp", "/healthz"));
    if (!health.ok) throw new Error("MCP health check failed.");
  } catch (error) {
    await close();
    throw error;
  }
  return { url, tools: getPiToolNames(tools), close };
}
