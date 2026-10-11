import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { startTunnel, type TunnelHandle } from "../src/tunnel-client.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "workspace-tools-tunnel-"));
}

async function writeFakeTunnelExecutable(
  dir: string,
  body: string,
): Promise<string> {
  const path = join(dir, "fake-tunnel-client.cjs");
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return path;
}

const fakeTunnelFixture = `
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
function value(flag) { const index = args.indexOf(flag); return index === -1 ? '' : args[index + 1]; }
const profileDir = value('--profile-dir');
const logFile = join(profileDir, '..', 'invocations.jsonl');
if (args[0] === 'run' && process.env.CONTROL_PLANE_API_KEY !== 'sk-secret-value') process.exit(65);
appendFileSync(logFile, JSON.stringify({ args }) + '\\n');
if (args[0] === 'init') {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'workspace-tools-mcp.yaml'), 'control_plane_api_key: env:CONTROL_PLANE_API_KEY\\n');
  process.exit(0);
}
if (args[0] === 'run') {
  let ready = false;
  const server = createServer((req, res) => {
    if (req.url === '/healthz') { res.end('ok'); return; }
    if (req.url === '/readyz') { res.statusCode = ready ? 200 : 503; res.end(ready ? 'ready' : 'not ready'); return; }
    res.statusCode = 404; res.end('missing');
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    writeFileSync(value('--health.url-file'), 'http://127.0.0.1:' + address.port + '\\n');
    setImmediate(() => { ready = true; });
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.stdin.resume();
} else {
  process.exit(64);
}
`;

test("fake tunnel executable fixture: start waits for readyz and keeps API key out of profile", async () => {
  const dir = await tempDir();
  try {
    const logFile = join(dir, "invocations.jsonl");
    const fake = await writeFakeTunnelExecutable(dir, fakeTunnelFixture);
    let handle: TunnelHandle;
    handle = await startTunnel({
      binaryPath: fake,
      runtimeDir: join(dir, "runtime"),
      tunnelId: "tunnel_test",
      apiKey: "sk-secret-value",
      mcpUrl: "http://127.0.0.1:12345/mcp",
      onLog: () => undefined,
    });
    const ready = await fetch(`${handle.healthUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal(handle.profile, "workspace-tools-mcp");
    const profile = await readFile(
      join(dir, "runtime", "workspace-tools-mcp.yaml"),
      "utf8",
    );
    assert.match(profile, /env:CONTROL_PLANE_API_KEY/);
    assert.doesNotMatch(profile, /sk-secret-value/);
    await handle.stop();
    await handle.stop();
    const invocations = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fake tunnel executable fixture: startup failure stops run and removes runtime", async () => {
  const dir = await tempDir();
  const failingRun = fakeTunnelFixture.replace(
    "setImmediate(() => { ready = true; });",
    "process.exit(42);",
  );
  try {
    const fake = await writeFakeTunnelExecutable(dir, failingRun);
    const logs: string[] = [];
    await assert.rejects(
      startTunnel({
        binaryPath: fake,
        runtimeDir: join(dir, "runtime"),
        tunnelId: "tunnel_test",
        apiKey: "sk-secret-value",
        mcpUrl: "http://127.0.0.1:12345/mcp",
        onLog: (message) => logs.push(message),
      }),
      (error: unknown) => {
        assert.match(String(error), /tunnel-client run exited unexpectedly/);
        assert.doesNotMatch(logs.join(""), /sk-secret-value/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
