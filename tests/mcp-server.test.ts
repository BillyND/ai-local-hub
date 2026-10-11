import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startMcpServer } from "../src/mcp-server.js";
import { createReadTool, createEditTool } from "@earendil-works/pi-coding-agent";

async function withClient<T>(fn: (client: Client, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-mcp-"));
  const server = await startMcpServer(root);
  const client = new Client({ name: "workspace-tools-mcp-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    return await fn(client, root);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("atomically caps concurrent initializes and releases capacity on DELETE", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-mcp-cap-"));
  const server = await startMcpServer(root, { maxSessions: 1 });
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "capacity-test", version: "1.0.0" } },
  });
  try {
    const responses = await Promise.all([1, 2].map(() => fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initialize,
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
    const rejected = responses.find((response) => response.status === 429)!;
    assert.equal(rejected.headers.get("retry-after"), "1");
    await rejected.text();
    const initialized = responses.find((response) => response.status === 200)!;
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await initialized.text();
    const deleted = await fetch(server.url, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    assert.equal(deleted.status, 200);

    const client = new Client({ name: "capacity-reuse-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const result = await client.callTool({ name: "write", arguments: { path: "capacity-reused.txt", content: "slot-reused" } });
      assert.equal(result.isError, undefined);
      assert.equal(await readFile(join(root, "capacity-reused.txt"), "utf8"), "slot-reused");
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaims abandoned idle sessions without expiring an active SSE session", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-idle-"));
  const server = await startMcpServer(root, { maxSessions: 2, sessionIdleTimeoutMs: 1_000 });
  const client = new Client({ name: "active-sse", version: "1.0.0" });
  const initialize = () => fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idle-test", version: "1.0.0" } } }),
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    await client.ping();
    const abandoned = await initialize();
    assert.equal(abandoned.status, 200);
    const id = abandoned.headers.get("mcp-session-id")!;
    await abandoned.text();
    context.mock.timers.tick(2_000);
    const stale = await fetch(server.url, { method: "DELETE", headers: { "mcp-session-id": id } });
    assert.equal(stale.status, 404);
    await stale.text();
    const reclaimed = await initialize();
    assert.equal(reclaimed.status, 200);
    await reclaimed.text();
    const result = await client.callTool({ name: "write", arguments: { path: "still-active.txt", content: "active-sse-preserved" } });
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(root, "still-active.txt"), "utf8"), "active-sse-preserved");
  } finally {
    await client.close();
    await server.close();
    context.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  }
});

function text(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

test("advertises and executes the full Pi built-in tool surface", async () => {
  await withClient(async (client, root) => {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(listed, ["read", "bash", "edit", "write", "grep", "find", "ls", ...(process.platform === "win32" ? ["powershell"] : [])]);
    const write = await client.callTool({ name: "write", arguments: { path: "sample.txt", content: "needle\nsecond line\n" } });
    assert.equal(write.isError, undefined);
    assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "needle\nsecond line\n");
    const read = await client.callTool({ name: "read", arguments: { path: "sample.txt" } });
    assert.match(text(read), /needle/);
    const edit = await client.callTool({ name: "edit", arguments: { path: "sample.txt", edits: [{ oldText: "second line", newText: "edited line" }] } });
    assert.equal(edit.isError, undefined);
    assert.match(await readFile(join(root, "sample.txt"), "utf8"), /edited line/);
    const grep = await client.callTool({ name: "grep", arguments: { pattern: "edited", path: "." } });
    assert.match(text(grep), /sample\.txt/);
    const find = await client.callTool({ name: "find", arguments: { pattern: "*.txt", path: "." } });
    assert.match(text(find), /sample\.txt/);
    const ls = await client.callTool({ name: "ls", arguments: { path: "." } });
    assert.match(text(ls), /sample\.txt/);
    const bash = await client.callTool({ name: "bash", arguments: { command: "printf bash-ok" } });
    assert.match(text(bash), /bash-ok/);
  });
});

test("returns an MCP tool error for an underlying Pi tool failure", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "read",
      arguments: { path: "missing-file.txt" },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /missing-file|Could not|ENOENT/i);
  });
});

test("preserves canonical Pi schemas while normalizing edit compatibility input before validation", async () => {
  await withClient(async (client, root) => {
    const tools = (await client.listTools()).tools;
    for (const tool of [createReadTool(root), createEditTool(root)]) {
      assert.deepEqual(
        tools.find((item) => item.name === tool.name)?.inputSchema,
        JSON.parse(JSON.stringify(tool.parameters)),
      );
    }
    await writeFile(join(root, "compat.txt"), "old text", "utf8");
    const result = await client.callTool({
      name: "edit",
      arguments: { path: "compat.txt", oldText: "old text", newText: "new text" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(root, "compat.txt"), "utf8"), "new text");
    const invalid = await client.callTool({
      name: "edit",
      arguments: { path: "compat.txt", edits: [{ oldText: "new text", newText: 7 }] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(await readFile(join(root, "compat.txt"), "utf8"), "new text");
  });
});

test("read preserves offset/limit, truncation and native image blocks", async () => {
  await withClient(async (client, root) => {
    await writeFile(join(root, "lines.txt"), "first\nsecond\nthird\n");
    const slice = await client.callTool({ name: "read", arguments: { path: "lines.txt", offset: 2, limit: 1 } });
    assert.match(text(slice), /^second\n/);
    assert.doesNotMatch(text(slice), /first|third/);
    const long = "x".repeat(60_000);
    await writeFile(join(root, "long.txt"), long);
    const truncated = CallToolResultSchema.parse(await client.callTool({ name: "read", arguments: { path: "long.txt" } }));
    assert.equal(truncated.isError, undefined);
    assert.notEqual(text(truncated), long);
    assert.match(text(truncated), /truncat|exceed|KB|bytes|bash/i);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(root, "pixel.png"), png);
    const image = CallToolResultSchema.parse(await client.callTool({ name: "read", arguments: { path: "pixel.png" } }));
    assert.equal(image.isError, undefined);
    assert.equal(image.content.find((item) => item.type === "image")?.type, "image");
  });
});

test("bash reports merged stdout/stderr, nonzero exit, wall time, progress, timeout and invalid arguments", async () => {
  await withClient(async (client) => {
    const result = CallToolResultSchema.parse(await client.callTool({
      name: "bash",
      arguments: { command: "printf stdout-marker; printf stderr-marker >&2; exit 7" },
    }));
    assert.equal(result.isError, true);
    assert.match(text(result), /stdout-marker/);
    assert.match(text(result), /stderr-marker/);
    assert.equal(result.structuredContent?.exit_code, 7);
    assert.equal(typeof result.structuredContent?.wall_time_seconds, "number");
    const updates: string[] = [];
    await client.callTool({ name: "bash", arguments: { command: "printf progress-marker; sleep 0.3" }, _meta: { progressToken: "progress-test" } }, undefined, {
      onprogress: (progress) => { if (progress.message) updates.push(progress.message); },
    });
    assert.match(updates.join("\n"), /progress-marker/);
    const timeout = await client.callTool({ name: "bash", arguments: { command: "sleep 20", timeout: 0.05 } });
    assert.equal(timeout.isError, true);
    assert.match(text(timeout), /timed out|timeout/i);
    const invalid = await client.callTool({ name: "read", arguments: { path: 42 } });
    assert.equal(invalid.isError, true);
  });
});
