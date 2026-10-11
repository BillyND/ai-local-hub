// Verifies the staged desktop runtime for the current machine, the way the desktop shell runs it:
// the embedded Bun starts the bundled manager (`--desktop`), serves the UI, runs a real instance
// with all tools, and everything stops when stdin closes.
//
// Usage: node scripts/smoke-desktop-runtime.mjs [--target <rust-triple>]   (run stage-desktop first)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const flag = process.argv.indexOf("--target");
const triple = (flag >= 0 && process.argv[flag + 1]) || HOST_TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`Unsupported host ${process.platform}-${process.arch}`);

const runtime = join(root, "desktop", "src-tauri", "binaries", `ai-local-hub-bun-${triple}${triple.includes("windows") ? ".exe" : ""}`);
const dist = join(root, "desktop", "src-tauri", "resources", "app", "dist");
for (const path of [runtime, join(dist, "ai-local-hub.mjs")])
  if (!existsSync(path)) throw new Error(`${path} is missing. Run node scripts/stage-desktop.mjs first.`);

const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
};
const within = (ms, what, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);

const work = mkdtempSync(join(tmpdir(), "wtm-desktop-smoke-"));
const workspace = join(work, "ws");
mkdirSync(workspace);
writeFileSync(
  join(work, "config.json"),
  JSON.stringify({ version: 2, cacheDir: join(work, "cache"), instances: [{ id: "i1", name: "smoke", workspaceRoot: workspace, tunnelId: "t", apiKey: "k" }] }),
);
const env = { ...process.env, WORKSPACE_TOOLS_CONFIG_FILE: join(work, "config.json"), WORKSPACE_TOOLS_CACHE_DIR: join(work, "cache") };

const manager = spawn(runtime, ["--no-install", "--no-env-file", join(dist, "ai-local-hub.mjs"), "--desktop", "--local-only"], {
  cwd: dist,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
manager.stderr.on("data", (chunk) => (stderr += chunk));
const exited = new Promise((resolve) => manager.once("exit", (code) => resolve(code)));
let mcpUrl;
try {
  const ready = await within(
    30_000,
    "the ready line",
    new Promise((resolve, reject) => {
      createInterface({ input: manager.stdout }).once("line", (line) => resolve(JSON.parse(line)));
      manager.once("exit", () => reject(new Error(`manager exited early: ${stderr}`)));
    }),
  );
  check(ready.type === "ready" && ready.owner === true, "the manager prints a ready line and owns the session");
  const base = new URL(ready.url).origin;
  const cookie = (await fetch(ready.url, { redirect: "manual" })).headers.get("set-cookie")?.split(";")[0];
  check(Boolean(cookie), "the token link sets the session cookie");
  const api = async (method, path) => {
    const response = await fetch(base + path, { method, headers: { cookie, origin: base, "content-type": "application/json" } });
    return response.status === 204 ? null : response.json();
  };
  const page = await fetch(base + "/", { headers: { cookie } });
  check(page.status === 200 && /<title>AI Local Hub<\/title>/.test(await page.text()), "the bundled web UI is served");

  await api("POST", "/api/instances/i1/start");
  for (let i = 0; i < 300 && !mcpUrl; i += 1) {
    const state = await api("GET", "/api/state");
    const status = state.instances[0].status;
    if (status.state === "error") throw new Error(`instance failed: ${status.error}`);
    mcpUrl = status.url;
    if (!mcpUrl) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(Boolean(mcpUrl), "a worker started under the embedded runtime");
  const client = new Client({ name: "desktop-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  check(tools.length === 7, `the worker exposes all tools (${tools.join(", ")})`);
  const result = await client.callTool({ name: "bash", arguments: { command: "echo smoke-ok" } });
  check(result.content.some((part) => part.text?.includes("smoke-ok")), "a tool call runs a shell command");
  await client.close();

  manager.stdin.end();
  check((await within(30_000, "the manager to stop", exited)) === 0, "closing stdin stops the manager with exit code 0");
  check(await fetch(mcpUrl).then(() => false, () => true), "the worker stopped with the manager");
  check(!existsSync(join(work, "manager.lock")), "the lock file was released");
  console.log(`\nDesktop runtime smoke test passed for ${triple}.`);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  if (stderr) console.error(`manager stderr:\n${stderr}`);
  process.exitCode = 1;
} finally {
  manager.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}
