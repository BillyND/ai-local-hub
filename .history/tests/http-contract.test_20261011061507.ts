import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMcpServer } from "../src/mcp-server.js";

test("rejects malformed MCP JSON with a client error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-http-"));
  const server = await startMcpServer(root);
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Invalid JSON/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closes the loopback listener cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-http-"));
  const server = await startMcpServer(root);
  await server.close();
  await assert.rejects(fetch(server.url), /fetch failed|ECONNREFUSED|socket/i);
  await rm(root, { recursive: true, force: true });
});

test("stale session IDs return 404 so clients can reinitialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-http-"));
  const server = await startMcpServer(root);
  try {
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(server.url, {
        method,
        headers: {
          "mcp-session-id": "expired-session",
          "content-type": "application/json",
        },
        ...(method === "POST"
          ? {
              body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stale","version":"1"}}}',
            }
          : {}),
      });
      assert.equal(response.status, 404);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
