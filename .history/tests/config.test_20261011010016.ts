import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';

test('prefers environment configuration and resolves workspace realpath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tools-config-'));
  try {
    const config = await resolveConfig({
      cwd: root,
      localOnly: false,
      env: {
        WORKSPACE_ROOT: '.',
        CONTROL_PLANE_TUNNEL_ID: 'tunnel_test',
        CONTROL_PLANE_API_KEY: 'sk-test',
        PI_TOOLS_MCP_CACHE_DIR: join(root, 'cache'),
      },
      prompt: async () => { throw new Error('prompt must not run'); },
    });
    assert.equal(config.workspaceRoot, await realpath(root));
    assert.equal(config.tunnelId, 'tunnel_test');
    assert.equal(config.apiKey, 'sk-test');
    assert.equal(config.cacheDir, join(root, 'cache'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local-only configuration does not request tunnel credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tools-config-'));
  try {
    const config = await resolveConfig({
      cwd: root,
      localOnly: true,
      env: { WORKSPACE_ROOT: '.' },
      prompt: async () => { throw new Error('prompt must not run'); },
    });
    assert.equal(config.tunnelId, '');
    assert.equal(config.apiKey, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing workspace directory', async () => {
  await assert.rejects(resolveConfig({
    env: { WORKSPACE_ROOT: join(tmpdir(), 'does-not-exist-pi-tools') },
    prompt: async () => { throw new Error('prompt must not run'); },
  }), /WORKSPACE_ROOT must be an existing directory/);
});
