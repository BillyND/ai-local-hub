import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createPiTools } from './pi-tools.js';
import { getPiToolNames, registerPiTools } from './pi-tool-adapter.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpHandle {
  url: string;
  tools: string[];
  close(): Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw new Error('MCP request body exceeds 4 MiB.');
    chunks.push(bytes);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}

export async function startMcpServer(workspaceRoot: string, port = 0): Promise<McpHandle> {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as unknown;
  if (!packageJson || typeof packageJson !== 'object' || !('version' in packageJson) || typeof packageJson.version !== 'string') {
    throw new Error('package.json is missing its version.');
  }
  const version = packageJson.version;
  const tools = createPiTools(workspaceRoot);
  const shutdown = new AbortController();
  const sessions = new Map<string, Session>();
  const requests = new Set<Promise<void>>();
  let closing = false;
  const http = createServer((request, response) => {
    const execution = handleRequest(request, response).catch(() => {
      writeError(response, 500, 'MCP transport failed');
    }).finally(() => requests.delete(execution));
    requests.add(execution);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) { writeError(response, 503, 'MCP server is shutting down'); return; }
    const host = request.headers.host ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(host)) { writeError(response, 403, 'Invalid Host'); return; }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) { writeError(response, 403, 'Invalid Origin'); return; }
    if (request.url === '/healthz' || request.url === '/readyz') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ready":true}');
      return;
    }
    if (request.url !== '/mcp') { writeError(response, 404, 'Not found'); return; }
    let body: unknown;
    if (request.method === 'POST') {
      try {
        body = await readJsonBody(request);
      } catch (error: unknown) {
        writeError(response, 400, error instanceof SyntaxError ? 'Invalid JSON body' : 'Invalid MCP request body');
        return;
      }
    }
    const sessionId = request.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (typeof sessionId === 'string' && !session) { writeError(response, 404, 'MCP session not found.'); return; }
    if (session) {
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (request.method === 'POST') {
      if (!isInitializeRequest(body)) { writeError(response, 400, 'Missing MCP session.'); return; }
      let createdSessionId: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { createdSessionId = id; },
        onsessionclosed: async (id) => {
          const existing = sessions.get(id);
          sessions.delete(id);
          if (existing) await existing.server.close();
        },
      });
      const server = new McpServer({ name: 'pi-tools-mcp', version }, {
        instructions: `Use these Pi SDK tools directly. Relative paths and shell commands start in ${workspaceRoot}. Full process permissions are enabled; the workspace is not a sandbox. Use read before edit; edit requires exact unique oldText replacements in edits[].`,
      });
      registerPiTools(server, tools, shutdown.signal);
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      if (createdSessionId) sessions.set(createdSessionId, { server, transport });
      return;
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      writeError(response, 400, 'MCP session ID is required.');
      return;
    }
    writeError(response, 405, 'Method not allowed');
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP listener has no TCP address.');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const health = await fetch(url.replace('/mcp', '/healthz'));
  if (!health.ok) throw new Error('MCP health check failed.');
  let closePromise: Promise<void> | undefined;
  return {
    url,
    tools: getPiToolNames(tools),
    close() {
      closePromise ??= (async () => {
        closing = true;
        shutdown.abort(new Error('MCP server is shutting down.'));
        http.closeAllConnections();
        await Promise.race([Promise.allSettled([...requests]), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
        await Promise.allSettled([...sessions.values()].map(async ({ server, transport }) => {
          await transport.close();
          await server.close();
        }));
        sessions.clear();
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      })();
      return closePromise;
    },
  };
}
