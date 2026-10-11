import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const entry = new URL("../src/index.ts", import.meta.url).pathname;
// WTM_TEST_RUNTIME=/path/to/bun runs the whole suite on the runtime the desktop app ships (Bun
// runs the TypeScript sources directly); by default it uses the Node that runs the tests.
const runtime = process.env.WTM_TEST_RUNTIME || process.execPath;
const runtimeArgs = runtime === process.execPath ? process.execArgv : [];

interface Ready {
  type: string;
  url: string;
  owner: boolean;
}

function startManager(env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; ready: Promise<Ready>; exit: Promise<number | null> } {
  const child = spawn(runtime, [...runtimeArgs, entry, "--desktop", "--local-only"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ready line")), 20_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line) as Ready);
    });
    child.once("exit", () => reject(new Error("exited before ready")));
  });
  ready.catch(() => undefined);
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, ready, exit };
}

async function withEnv(run: (env: NodeJS.ProcessEnv, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-desktop-"));
  await mkdir(join(root, "ws"));
  const configPath = join(root, "config", "config.json");
  await mkdir(join(root, "config"));
  await writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      cacheDir: join(root, "cache"),
      instances: [{ id: "i1", name: "one", workspaceRoot: join(root, "ws"), tunnelId: "t1", apiKey: "k1" }],
    }),
  );
  try {
    await run({ WORKSPACE_TOOLS_CONFIG_FILE: configPath, WORKSPACE_TOOLS_CACHE_DIR: join(root, "cache") }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function session(link: string): Promise<{ base: string; call: (method: string, path: string) => Promise<Response> }> {
  const base = new URL(link).origin;
  const redirect = await fetch(link, { redirect: "manual" });
  const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { base, call: (method, path) => fetch(base + path, { method, headers: { cookie, origin: base, "content-type": "application/json" } }) };
}

test("desktop mode: prints a JSON ready line, serves the UI API and quits when stdin closes", async () => {
  await withEnv(async (env, root) => {
    const first = startManager(env);
    try {
      const ready = await first.ready;
      assert.equal(ready.type, "ready");
      assert.equal(ready.owner, true);
      assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
      const { call } = await session(ready.url);
      const state = (await (await call("GET", "/api/state")).json()) as { instances: { status: { state: string; url?: string } }[] };
      assert.equal(state.instances.length, 1);

      // A running instance must die with the manager.
      await call("POST", "/api/instances/i1/start");
      let mcpUrl: string | undefined;
      for (let i = 0; i < 300 && !mcpUrl; i += 1) {
        const s = (await (await call("GET", "/api/state")).json()) as typeof state;
        mcpUrl = s.instances[0]?.status.url;
        if (!mcpUrl) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(mcpUrl, "instance started");

      first.child.stdin.end();
      assert.equal(await first.exit, 0, "closing stdin stops the manager gracefully");
      assert.equal(existsSync(join(root, "config", "manager.lock")), false, "lock is released");
      await assert.rejects(fetch(mcpUrl), "the worker stopped with the manager");
    } finally {
      first.child.kill("SIGKILL");
    }
  });
});

test("desktop mode: a second app attaches to the running manager without owning it", async () => {
  await withEnv(async (env) => {
    const first = startManager(env);
    try {
      const a = await first.ready;
      const second = startManager(env);
      const b = await second.ready;
      assert.equal(b.owner, false);
      assert.equal(b.url, a.url, "attaches to the same manager and token");
      assert.equal(await second.exit, 0);
      const { call } = await session(a.url);
      assert.equal((await call("GET", "/api/state")).status, 200, "the first manager is unaffected");
      first.child.stdin.end();
      assert.equal(await first.exit, 0);
    } finally {
      first.child.kill("SIGKILL");
    }
  });
});

test("desktop mode: Quit from the UI stops the manager even though stdin stays open", async () => {
  await withEnv(async (env, root) => {
    const manager = startManager(env);
    try {
      const { url } = await manager.ready;
      const { base, call } = await session(url);
      assert.equal((await call("POST", "/api/shutdown")).status, 202);
      const code = await Promise.race([
        manager.exit,
        new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 10_000)),
      ]);
      assert.equal(code, 0, "the process exits after /api/shutdown without stdin being closed");
      assert.equal(existsSync(join(root, "config", "manager.lock")), false);
      await assert.rejects(fetch(base), "the server is gone");
    } finally {
      manager.child.kill("SIGKILL");
    }
  });
});
