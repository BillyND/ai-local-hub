//! One structured log line per MCP tool call, sent to the manager over the worker's stdout.
//! The manager forwards it to the instance Logs panel, where the UI renders time/level/fields.
use rmcp::model::CallToolResult;
use serde_json::{json, Map, Value};
use std::{future::Future, time::{Instant, SystemTime, UNIX_EPOCH}};

const MAX_FIELD_CHARS: usize = 300;

/// Shortens a value for the log without splitting a character.
pub fn brief(text: &str) -> String {
    let mut out: String = text.chars().take(MAX_FIELD_CHARS).collect();
    if text.chars().count() > MAX_FIELD_CHARS { out.push('…'); }
    out
}

fn iso_time() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (now.as_secs() as i64, now.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn error_text(result: &CallToolResult) -> Option<String> {
    result.content.iter().find_map(|block| block.as_text().map(|text| brief(&text.text)))
}

fn record(tool: &str, detail: Value, started: Instant, result: &CallToolResult) {
    let failed = result.is_error == Some(true);
    let mut fields = Map::new();
    fields.insert("time".into(), json!(iso_time()));
    fields.insert("level".into(), json!(if failed { "ERROR" } else { "INFO" }));
    fields.insert("msg".into(), json!(format!("tool {tool} {}", if failed { "failed" } else { "ok" })));
    fields.insert("tool".into(), json!(tool));
    // Unset optional arguments (null) are noise in the log.
    if let Value::Object(map) = detail { fields.extend(map.into_iter().filter(|(_, v)| !v.is_null())); }
    fields.insert("duration_ms".into(), json!(started.elapsed().as_millis() as u64));
    if failed { if let Some(error) = error_text(result) { fields.insert("error".into(), json!(error)); } }
    println!("{}", json!({"type": "log", "message": Value::Object(fields).to_string()}));
}

pub fn traced(tool: &str, detail: Value, run: impl FnOnce() -> CallToolResult) -> CallToolResult {
    let started = Instant::now();
    let result = run();
    record(tool, detail, started, &result);
    result
}

pub async fn traced_async(tool: &str, detail: Value, run: impl Future<Output = CallToolResult>) -> CallToolResult {
    let started = Instant::now();
    let result = run.await;
    record(tool, detail, started, &result);
    result
}
