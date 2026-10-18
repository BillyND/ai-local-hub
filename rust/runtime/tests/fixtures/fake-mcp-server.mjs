// Scriptable stdio MCP server used by mcp-gateway-smoke.mjs.
// It keeps a `sleep` grandchild alive so the test can prove the whole process group is stopped.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const grandchild = spawn("sleep", ["600"], { stdio: "ignore" });
const server = new McpServer({ name: "fake", version: "1.0.0" });
const text = (value) => ({ content: [{ type: "text", text: value }] });

server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true, destructiveHint: false } },
  async ({ text: value }) => text(`echo:${value}`));
server.registerTool("whoami", { description: "Process facts" },
  async () => text(JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, cwd: process.cwd(), token: process.env.FAKE_TOKEN ?? null })));
server.registerTool("slow", { description: "Wait, honouring cancellation", inputSchema: { ms: z.number() } },
  async ({ ms }, extra) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(text("slow done")), ms);
    extra.signal.addEventListener("abort", () => { clearTimeout(timer); writeFileSync(join(process.cwd(), "slow-cancelled"), "yes"); });
  }));
server.registerTool("big", { description: "Return a large text", inputSchema: { bytes: z.number() } },
  async ({ bytes }) => text("x".repeat(bytes)));
server.registerTool("crash", { description: "Exit the server" }, async () => { process.exit(3); });
server.registerTool("weird.name", { description: "Dotted tool name" }, async () => text("weird ok"));

// Simulates a slow first start (e.g. an `npx` download) so the test can stop the worker mid-startup.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_START_DELAY_MS ?? 0)));
console.error("fake server started");
if (process.env.FAKE_TOKEN) console.error(`token ${process.env.FAKE_TOKEN}`);
await server.connect(new StdioServerTransport());
