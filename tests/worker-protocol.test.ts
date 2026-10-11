import assert from "node:assert/strict";
import test from "node:test";
import { encodeEvent, parseEvent, type WorkerEvent } from "../src/worker-protocol.js";

test("events round-trip through one JSON line", () => {
  const events: WorkerEvent[] = [
    { type: "log", message: "hello" },
    { type: "phase", message: "Connecting tunnel" },
    { type: "mcp", url: "http://127.0.0.1:1/mcp" },
    { type: "ready", tunnel: true },
    { type: "fatal", message: "boom" },
  ];
  for (const event of events) {
    const line = encodeEvent(event);
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.trimEnd().includes("\n"), false);
    assert.deepEqual(parseEvent(line.trimEnd()), event);
  }
});

test("malformed or unknown lines are not events", () => {
  for (const line of ["plain text", "", "{", "null", "[]", '{"type":"nope"}', '{"type":"log"}', '{"type":"ready","tunnel":"yes"}', '{"type":"mcp","url":1}'])
    assert.equal(parseEvent(line), undefined, line);
});
