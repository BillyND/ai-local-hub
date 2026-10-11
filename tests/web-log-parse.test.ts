import assert from "node:assert/strict";
import test from "node:test";
import { parseLogLine } from "../web/src/lib/parse-log-line.ts";

test("structured slog records become time, level, message and fields", () => {
  const line = JSON.stringify({
    time: "2026-10-11T12:35:21.463931+07:00",
    level: "INFO",
    msg: "Codex detected install",
    plugin_dir: "/Users/x/.codex/plugins",
    attempts: 3,
    ok: true,
    nothing: null,
    urls: ["a", "b"],
  });
  const parsed = parseLogLine(line);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.level, "INFO");
  assert.equal(parsed.message, "Codex detected install");
  assert.match(parsed.time ?? "", /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.deepEqual(parsed.fields, [
    { key: "plugin_dir", value: "/Users/x/.codex/plugins" },
    { key: "attempts", value: "3" },
    { key: "ok", value: "true" },
    { key: "nothing", value: "null" },
    { key: "urls", value: '["a","b"]' },
  ]);
});

test("levels are normalized and unknown timestamps are kept verbatim", () => {
  const parsed = parseLogLine('{"time":"yesterday","level":"warning","msg":"careful"}');
  assert.equal(parsed.level, "WARN");
  assert.equal(parsed.time, "yesterday");
  assert.equal(parseLogLine('{"message":"alt key","level":"error"}').message, "alt key");
});

test("anything that is not a JSON log record stays plain text", () => {
  for (const line of [
    "MCP ready: http://127.0.0.1:54924/mcp",
    "Tunnel ready: http://127.0.0.1:54929",
    "{not json}",
    '{"no":"message field"}',
    '["array"]',
    "{}",
    "",
  ]) {
    const parsed = parseLogLine(line);
    assert.equal(parsed.structured, false, line);
    assert.equal(parsed.message, line);
    assert.deepEqual(parsed.fields, []);
  }
});
