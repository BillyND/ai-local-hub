import assert from "node:assert/strict";
import test from "node:test";
import { ToolCapacity } from "../src/tool-capacity.js";

test("process saturation does not block files, and full queues reject excess work", async () => {
  const capacity = new ToolCapacity(1, 1, 1, 0);
  const signal = new AbortController().signal;
  const processRelease = await capacity.acquire("bash", signal);
  assert.ok(processRelease);
  assert.equal(await capacity.acquire("grep", signal), undefined);
  const fileRelease = await capacity.acquire("read", signal);
  assert.ok(fileRelease);
  const queued = capacity.acquire("write", signal);
  assert.equal(await capacity.acquire("edit", signal), undefined);
  fileRelease();
  const queuedRelease = await queued;
  assert.ok(queuedRelease);
  assert.equal(await capacity.acquire("find", signal), undefined);
  queuedRelease();
  processRelease();
  const reused = await capacity.acquire("bash", signal);
  assert.ok(reused);
  reused();
});

test("cancelled queued work frees its queue position without consuming a slot", async () => {
  const capacity = new ToolCapacity(1, 1, 1, 0);
  const initial = await capacity.acquire("read", new AbortController().signal);
  assert.ok(initial);
  const controller = new AbortController();
  const cancelled = capacity.acquire("write", controller.signal);
  const reason = new Error("request cancelled");
  const rejection = assert.rejects(cancelled, (error) => error === reason);
  controller.abort(reason);
  await rejection;
  const replacement = capacity.acquire("edit", new AbortController().signal);
  initial();
  const release = await replacement;
  assert.ok(release);
  release();
  const available = await capacity.acquire("read", new AbortController().signal);
  assert.ok(available);
  available();
});
