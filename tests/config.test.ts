import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";

test("prefers environment configuration and resolves workspace realpath", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-config-"));
  try {
    const config = await resolveConfig({
      cwd: root,
      configPath: join(root, "settings", "config.json"),
      localOnly: false,
      env: {
        WORKSPACE_ROOT: ".",
        OPENAI_TUNNEL_ID: "tunnel_test",
        OPENAI_API_KEY: "sk-test",
        WORKSPACE_TOOLS_CACHE_DIR: join(root, "cache"),
      },
      prompt: async () => { throw new Error("prompt must not run"); },
    });
    assert.equal(config.workspaceRoot, await realpath(root));
    assert.equal(config.tunnelId, "tunnel_test");
    assert.equal(config.apiKey, "sk-test");
    assert.equal(config.cacheDir, join(root, "cache"));
    assert.equal(config.loadedFromDisk, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only configuration does not request tunnel credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-config-"));
  try {
    const config = await resolveConfig({
      cwd: root,
      localOnly: true,
      configPath: join(root, "settings", "config.json"),
      env: { WORKSPACE_ROOT: "." },
      prompt: async () => { throw new Error("prompt must not run"); },
    });
    assert.equal(config.tunnelId, "");
    assert.equal(config.apiKey, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists settings, reuses them, and resets them", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-config-"));
  const configPath = join(root, "settings", "config.json");
  try {
    const first = await resolveConfig({
      cwd: root,
      configPath,
      env: { WORKSPACE_ROOT: ".", OPENAI_TUNNEL_ID: "tunnel_saved", OPENAI_API_KEY: "sk_saved" },
      prompt: async () => { throw new Error("prompt must not run"); },
    });
    assert.equal(first.loadedFromDisk, false);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: 1,
      workspaceRoot: await realpath(root),
      openaiTunnelId: "tunnel_saved",
      openaiApiKey: "sk_saved",
      cacheDir: join(homedir(), ".cache", "workspace-tools-mcp"),
    });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const reused = await resolveConfig({ cwd: root, configPath, env: {}, prompt: async () => { throw new Error("prompt must not run"); } });
    assert.equal(reused.loadedFromDisk, true);
    assert.equal(reused.tunnelId, "tunnel_saved");
    assert.equal(reused.apiKey, "sk_saved");

    await resolveConfig({ cwd: root, configPath, reset: true, localOnly: true, env: { WORKSPACE_ROOT: "." }, prompt: async () => { throw new Error("prompt must not run"); } });
    const reset = await readFile(configPath, "utf8");
    assert.doesNotMatch(reset, /sk_saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing workspace directory", async () => {
  await assert.rejects(
    resolveConfig({
      configPath: join(tmpdir(), `workspace-tools-missing-config-${process.pid}.json`),
      env: { WORKSPACE_ROOT: join(tmpdir(), "does-not-exist-workspace-tools") },
      prompt: async () => { throw new Error("prompt must not run"); },
    }),
    /Workspace folder must be an existing directory/,
  );
});
