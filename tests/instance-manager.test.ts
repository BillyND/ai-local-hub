import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { InstanceConfig } from "../src/config.js";
import { InstanceManager, type InstanceState } from "../src/instance-manager.js";

const entryScript = new URL("../src/worker-main.ts", import.meta.url).pathname;

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-manager-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const config = (id: string, root: string): InstanceConfig => ({
  id,
  name: id,
  workspaceRoot: root,
  tunnelId: `tunnel_${id}`,
  apiKey: `sk-secret-${id}`,
});

function waitForState(manager: InstanceManager, id: string, want: InstanceState): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error(`timed out waiting for ${id} to be ${want}; is ${manager.status(id).state}`)),
    30_000,
  );
  const check = (): void => {
    if (manager.status(id).state !== want) return;
    clearTimeout(timer);
    manager.removeListener("change", check);
    resolve();
  };
  manager.on("change", check);
  check();
  return promise;
}

async function listTools(url: string): Promise<string[]> {
  const client = new Client({ name: "manager-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test("two instances run as separate workers, serve MCP, and stop cleanly", async () => {
  await withWorkspace(async (root) => {
    const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript });
    const a = config("a", root);
    const b = config("b", root);
    try {
      await Promise.all([manager.start(a), manager.start(b)]);
      await Promise.all([waitForState(manager, "a", "running"), waitForState(manager, "b", "running")]);
      const urlA = manager.status("a").url;
      const urlB = manager.status("b").url;
      assert.ok(urlA && urlB && urlA !== urlB, "each instance has its own endpoint");
      assert.deepEqual(await listTools(urlA), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
      assert.deepEqual(await listTools(urlB), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
      assert.ok(manager.logs("a").some((line) => line.includes("MCP ready")));

      await manager.stop("a");
      assert.equal(manager.status("a").state, "stopped");
      assert.equal(manager.status("b").state, "running", "stopping one leaves the other running");
      await assert.rejects(fetch(urlA), "stopped instance no longer listens");
      assert.deepEqual(await listTools(urlB), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    } finally {
      await manager.stopAll();
    }
    assert.equal(manager.status("b").state, "stopped");
    assert.equal(manager.status("b").url, undefined);
  });
});

test("an instance can be restarted after it stopped", async () => {
  await withWorkspace(async (root) => {
    const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript });
    const a = config("a", root);
    try {
      await manager.start(a);
      await waitForState(manager, "a", "running");
      await manager.stop("a");
      await manager.start(a);
      await waitForState(manager, "a", "running");
      assert.ok(manager.status("a").url);
    } finally {
      await manager.stopAll();
    }
  });
});

test("a worker that cannot start reports an error with its message", async () => {
  await withWorkspace(async (root) => {
    const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript });
    try {
      await manager.start({ ...config("bad", root), workspaceRoot: "" });
      await waitForState(manager, "bad", "error");
      assert.match(manager.status("bad").error ?? "", /WORKSPACE_ROOT/);
    } finally {
      await manager.stopAll();
    }
  });
});

test("tunnel client resolution failure is an error and is retried on the next start", async () => {
  await withWorkspace(async (root) => {
    let calls = 0;
    const manager = new InstanceManager({
      cacheDir: root,
      localOnly: false,
      entryScript,
      tunnelBinary: async () => {
        calls += 1;
        throw new Error("download failed");
      },
    });
    const a = config("a", root);
    await manager.start(a);
    assert.equal(manager.status("a").state, "error");
    assert.match(manager.status("a").error ?? "", /download failed/);
    await manager.start(a);
    assert.equal(calls, 2, "a failed download is not cached");
  });
});

test("API keys never reach the stored logs", async () => {
  await withWorkspace(async (root) => {
    const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript });
    const a = config("a", root);
    try {
      await manager.start(a);
      await waitForState(manager, "a", "running");
    } finally {
      await manager.stopAll();
    }
    assert.equal(manager.logs("a").some((line) => line.includes(a.apiKey)), false);
  });
});
