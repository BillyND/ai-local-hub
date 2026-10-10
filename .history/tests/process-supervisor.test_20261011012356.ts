import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnManaged } from "../src/process-supervisor.js";

const node = process.execPath;

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pi-tools-supervisor-"));
}

test("redacts secrets split across every streamed output chunk boundary", async () => {
  const secret = "token-123";
  for (let split = 1; split < secret.length; split += 1) {
    const logs: string[] = [];
    const first = secret.slice(0, split);
    const second = secret.slice(split);
    const proc = spawnManaged(node, ["-e", `process.stdout.write(${JSON.stringify(first)}); setImmediate(() => process.stdout.write(${JSON.stringify(second)}));`], { onLog: (message) => logs.push(message), secrets: [secret] });
    const exit = await proc.exited;
    assert.equal(exit.code, 0);
    assert.equal(logs.join(""), "[REDACTED]", `split ${split}`);
  }
});

test("stop terminates a real child process group", async () => {
  const dir = await tempDir();
  try {
    const marker = join(dir, "child.pid");
    // Both real OS processes must stay alive until supervised shutdown; stdin is /dev/null here.
    const proc = spawnManaged(node, ["-e", `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},3600000)'], { detached: false, stdio: 'ignore' }); writeFileSync(${JSON.stringify(marker)}, String(child.pid)); setInterval(()=>{},3600000);`]);
    let childPid = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        childPid = (await readFile(marker, "utf8")).trim();
        if (childPid) break;
      } catch { /* marker pending; process startup is an OS lifecycle boundary */ }
      // Integration boundary: the marker is produced by a real child process; polling is the only cross-platform readiness signal.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(childPid, /^\d+$/);
    await proc.stop();
    const exit = await proc.exited;
    assert.equal(exit.code, null);
    if (process.platform !== "win32") {
      let gone = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { process.kill(Number(childPid), 0); } catch { gone = true; break; }
        // Integration boundary: process-group reaping is asynchronous and has no awaitable Node event.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(gone, true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spawn errors settle without an unhandled rejection", async () => {
  const logs: string[] = [];
  const proc = spawnManaged(join(tmpdir(), "missing-pi-tools-command"), [], { onLog: (message) => logs.push(message) });
  const exit = await proc.exited;
  assert.deepEqual(exit, { code: null, signal: null });
  assert.match(logs.join(""), /failed to start/);
});
