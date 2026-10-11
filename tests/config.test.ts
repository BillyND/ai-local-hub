import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadConfig,
  removeSavedConfig,
  resolveCacheDir,
  resolveConfigPath,
} from "../src/config.js";
import { addInstance, removeInstance, updateInstance } from "../src/instances.js";

async function withRoot(run: (root: string, path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-config-"));
  try {
    await run(root, join(root, "settings", "config.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const input = (root: string, n: number) => ({
  name: `acct-${n}`,
  workspaceRoot: root,
  tunnelId: `tunnel_${n}`,
  apiKey: `sk-${n}`,
});

test("missing file loads an empty v2 config", async () => {
  await withRoot(async (_root, path) => {
    const config = await loadConfig(path);
    assert.equal(config.version, 2);
    assert.deepEqual(config.instances, []);
  });
});

test("adds, persists with 0600 mode, updates and removes instances", async () => {
  await withRoot(async (root, path) => {
    const first = await addInstance(path, input(root, 1));
    const second = await addInstance(path, input(root, 2));
    assert.notEqual(first.id, second.id);
    assert.equal(first.workspaceRoot, await realpath(root));
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await loadConfig(path)).instances.length, 2);

    const renamed = await updateInstance(path, first.id, {
      ...input(root, 1),
      name: "renamed",
      apiKey: "",
    });
    assert.equal(renamed.name, "renamed");
    assert.equal(renamed.apiKey, "sk-1", "empty key keeps the stored key");

    await removeInstance(path, first.id);
    const left = (await loadConfig(path)).instances;
    assert.deepEqual(left.map((o) => o.id), [second.id]);
  });
});

test("rejects duplicate names, duplicate tunnel ids and bad input", async () => {
  await withRoot(async (root, path) => {
    await addInstance(path, input(root, 1));
    await assert.rejects(addInstance(path, { ...input(root, 2), name: "ACCT-1" }), /already exists/);
    await assert.rejects(addInstance(path, { ...input(root, 2), tunnelId: "tunnel_1" }), /already used/);
    await assert.rejects(addInstance(path, { ...input(root, 2), apiKey: " " }), /API key is required/);
    await assert.rejects(addInstance(path, { ...input(root, 2), name: "x".repeat(41) }), /at most/);
    await assert.rejects(
      addInstance(path, { ...input(root, 2), workspaceRoot: join(root, "missing") }),
      /existing directory/,
    );
    assert.equal((await loadConfig(path)).instances.length, 1, "failed adds are not saved");
  });
});

test("migrates a v1 single-instance file", async () => {
  await withRoot(async (root, path) => {
    await mkdir(join(root, "settings"));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        workspaceRoot: root,
        openaiTunnelId: "tunnel_old",
        openaiApiKey: "sk-old",
        cacheDir: join(root, "cache"),
      }),
    );
    const config = await loadConfig(path);
    assert.equal(config.version, 2);
    assert.equal(config.cacheDir, join(root, "cache"));
    assert.deepEqual(config.instances.map((o) => [o.name, o.tunnelId, o.apiKey]), [
      ["default", "tunnel_old", "sk-old"],
    ]);
  });
});

test("v1 file without credentials migrates to no instances", async () => {
  await withRoot(async (root, path) => {
    await mkdir(join(root, "settings"));
    await writeFile(
      path,
      JSON.stringify({ version: 1, workspaceRoot: root, openaiTunnelId: "", openaiApiKey: "", cacheDir: root }),
    );
    assert.deepEqual((await loadConfig(path)).instances, []);
  });
});

test("invalid files fail with a reset hint", async () => {
  await withRoot(async (root, path) => {
    await mkdir(join(root, "settings"));
    await writeFile(path, "{not json");
    await assert.rejects(loadConfig(path), /Run with --reset/);
    await writeFile(path, JSON.stringify({ version: 2, cacheDir: root, instances: [{ id: 1 }] }));
    await assert.rejects(loadConfig(path), /Run with --reset/);
  });
});

test("reset removes the file and stale temporary files", async () => {
  await withRoot(async (root, path) => {
    await addInstance(path, input(root, 1));
    await writeFile(`${path}.123.tmp`, "stale");
    await removeSavedConfig(path);
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(`${path}.123.tmp`), { code: "ENOENT" });
  });
});

test("environment overrides the config path and cache directory", async () => {
  await withRoot(async (root) => {
    const saved = { version: 2 as const, cacheDir: join(root, "saved-cache"), instances: [] };
    assert.equal(resolveCacheDir(saved, {}, root), join(root, "saved-cache"));
    assert.equal(
      resolveCacheDir(saved, { WORKSPACE_TOOLS_CACHE_DIR: join(root, "env-cache") }, root),
      join(root, "env-cache"),
    );
    assert.equal(
      resolveConfigPath({ WORKSPACE_TOOLS_CONFIG_FILE: "custom.json" }, root),
      join(root, "custom.json"),
    );
  });
});
