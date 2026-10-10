import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../src/mcp-server.js';

const root = await mkdtemp(join(tmpdir(), 'pi-tools-smoke-'));
const server = await startMcpServer(root);
const client = new Client({ name: 'pi-tools-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  await client.callTool({ name: 'write', arguments: { path: 'smoke.txt', content: 'smoke-content\n' } });
  const read = await client.callTool({ name: 'read', arguments: { path: 'smoke.txt' } });
  assert.equal(read.isError, undefined);
  assert.match(JSON.stringify(read), /smoke-content/);
  const bash = await client.callTool({ name: 'bash', arguments: { command: 'printf smoke-bash' } });
  assert.equal(bash.isError, undefined);
  assert.match(JSON.stringify(bash), /smoke-bash/);
  assert.equal(await readFile(join(root, 'smoke.txt'), 'utf8'), 'smoke-content\n');
  console.log(JSON.stringify({ endpoint: server.url, tools: names, status: 'ok' }));
} finally {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
