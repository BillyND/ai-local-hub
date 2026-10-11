//! Model-facing LSP text: diagnostics, locations with context, symbols, code actions, workspace-edit previews.
use super::{lsp_client::uri_to_file, search_paths::format_rel_cwd};
use serde_json::Value;
use std::{fs, path::Path};

pub const ICON_OK: &str = "✔";
pub const ICON_ERR: &str = "✘";
pub const ICON_WARN: &str = "⚠";
pub const CURSOR: &str = "❯";

pub fn severity_name(d: &Value) -> &'static str { match d.get("severity").and_then(Value::as_u64).unwrap_or(1) { 1 => "error", 2 => "warning", 3 => "info", 4 => "hint", _ => "error" } }

fn strip_noise(message: &str) -> String {
    message.lines().filter(|l| { let t = l.trim(); !t.starts_with("for further information visit") && !t.starts_with("http://") && !t.starts_with("https://") }).collect::<Vec<_>>().join("\n").trim().to_string()
}

fn pos(d: &Value, which: &str) -> (u64, u64) { (d.pointer(&format!("/range/{which}/line")).and_then(Value::as_u64).unwrap_or(0), d.pointer(&format!("/range/{which}/character")).and_then(Value::as_u64).unwrap_or(0)) }

pub fn format_diagnostic(d: &Value, file: &str) -> String {
    let (line, col) = pos(d, "start");
    let source = d.get("source").and_then(Value::as_str).filter(|s| !s.is_empty()).map_or(String::new(), |s| format!("[{s}] "));
    let code = d.get("code").filter(|c| !c.is_null() && **c != Value::from(0) && **c != Value::from("")).map_or(String::new(), |c| format!(" ({})", c.as_str().map_or_else(|| c.to_string(), String::from)));
    format!("{file}:{}:{} [{}] {source}{}{code}", line + 1, col + 1, severity_name(d), strip_noise(d.get("message").and_then(Value::as_str).unwrap_or("")))
}

pub fn summary(diags: &[Value]) -> String {
    let mut counts = [0usize; 4];
    for d in diags { counts[match severity_name(d) { "error" => 0, "warning" => 1, "info" => 2, _ => 3 }] += 1; }
    let parts: Vec<String> = ["error", "warning", "info", "hint"].iter().zip(counts).filter(|(_, n)| *n > 0).map(|(k, n)| format!("{n} {k}(s)")).collect();
    if parts.is_empty() { "no issues".into() } else { parts.join(", ") }
}

pub fn sort_diagnostics(diags: &mut [Value]) {
    diags.sort_by(|a, b| {
        let key = |d: &Value| (d.get("severity").and_then(Value::as_u64).unwrap_or(1), pos(d, "start"), d.get("message").and_then(Value::as_str).unwrap_or("").to_string());
        key(a).cmp(&key(b))
    });
}

/// Groups `path:line:col [sev] ...` messages per file (omp `formatGroupedDiagnosticMessages`).
pub fn group_messages(messages: &[String]) -> String {
    let re = regex::Regex::new(r"^(.+?):(\d+:\d+\s+.*)$").expect("valid");
    let (mut groups, mut loose): (Vec<(String, Vec<String>)>, Vec<String>) = (Vec::new(), Vec::new());
    for m in messages {
        let Some(c) = re.captures(m) else { loose.push(m.clone()); continue };
        let (file, row) = (c[1].replace('\\', "/"), format!("  {}", &c[2]));
        match groups.iter_mut().find(|g| g.0 == file) { Some(g) => g.1.push(row), None => groups.push((file, vec![row])) }
    }
    let entries: Vec<(String, bool)> = groups.iter().map(|g| (g.0.clone(), false)).collect();
    let mut out: Vec<String> = Vec::new();
    let mut emitted = false;
    for ev in super::tree_output::events(&entries) {
        match ev {
            super::tree_output::Event::Dir { depth, name } => { if emitted { out.push(String::new()); } emitted = true; out.push(format!("{} {name}/", "#".repeat(depth + 1))); },
            super::tree_output::Event::File { depth, name, key } => {
                if emitted && (depth == 0) { out.push(String::new()); }
                emitted = true;
                out.push(format!("{} {name}", "#".repeat(depth + 1)));
                if let Some(g) = groups.iter().find(|g| g.0 == key) { out.extend(g.1.iter().cloned()); }
            },
        }
    }
    if !loose.is_empty() { out.push(String::new()); out.extend(loose); }
    out.join("\n")
}

/// Normalises Location | Location[] | LocationLink[] into plain locations.
pub fn locations(result: &Value) -> Vec<Value> {
    let items: Vec<&Value> = match result { Value::Array(a) => a.iter().collect(), Value::Null => vec![], v => vec![v] };
    items.into_iter().filter_map(|l| {
        if let Some(uri) = l.get("targetUri") { return Some(serde_json::json!({"uri": uri, "range": l.get("targetSelectionRange").or_else(|| l.get("targetRange")).cloned().unwrap_or(Value::Null)})); }
        l.get("uri").map(|_| l.clone())
    }).collect()
}

pub fn format_location(loc: &Value, cwd: &Path) -> String {
    let (line, col) = pos(loc, "start");
    format!("{}:{}:{}", format_rel_cwd(&uri_to_file(loc["uri"].as_str().unwrap_or("")), cwd, false), line + 1, col + 1)
}

/// `  path:line:col` plus the surrounding source lines (one before, one after).
pub fn format_location_with_context(loc: &Value, cwd: &Path) -> String {
    let header = format!("  {}", format_location(loc, cwd));
    let path = uri_to_file(loc["uri"].as_str().unwrap_or(""));
    let Ok(meta) = fs::metadata(&path) else { return header };
    if !meta.is_file() { return header; }
    let Ok(text) = fs::read_to_string(&path) else { return header };
    let lines: Vec<&str> = text.split('\n').collect();
    let target = pos(loc, "start").0 as usize + 1;
    let (from, to) = (target.saturating_sub(1).max(1), (target + 1).min(lines.len()));
    let body: Vec<String> = (from..=to).map(|n| format!("    {n}: {}", lines.get(n - 1).unwrap_or(&""))).collect();
    format!("{header}\n{}", body.join("\n"))
}

pub fn symbol_icon(kind: u64) -> &'static str {
    match kind { 1 => "📄", 2 | 3 | 23 => "📁", 4 => "📦", 5 | 11 => "⬢", 6 | 9 | 12 => "⟲", _ => "•" }
}

pub fn document_symbol(s: &Value, indent: usize, out: &mut Vec<String>) {
    let detail = s.get("detail").and_then(Value::as_str).filter(|d| !d.is_empty()).map_or(String::new(), |d| format!(" {d}"));
    out.push(format!("{}{} {}{detail} @ line {}", "  ".repeat(indent), symbol_icon(s["kind"].as_u64().unwrap_or(0)), s["name"].as_str().unwrap_or(""), pos(s, "start").0 + 1));
    for c in s.get("children").and_then(Value::as_array).into_iter().flatten() { document_symbol(c, indent + 1, out); }
}

pub fn symbol_information(s: &Value, cwd: &Path) -> String {
    let container = s.get("containerName").and_then(Value::as_str).filter(|c| !c.is_empty()).map_or(String::new(), |c| format!(" ({c})"));
    let loc = s.get("location").cloned().unwrap_or(Value::Null);
    format!("{} {}{container} @ {}", symbol_icon(s["kind"].as_u64().unwrap_or(0)), s["name"].as_str().unwrap_or(""), format_location(&loc, cwd))
}

pub fn code_action_line(a: &Value, index: usize) -> String {
    let kind = a.get("kind").and_then(Value::as_str).unwrap_or("action");
    let preferred = if a.get("isPreferred").and_then(Value::as_bool) == Some(true) { " (preferred)" } else { "" };
    let disabled = a.get("disabled").map_or(String::new(), |d| format!(" (disabled: {})", d.get("reason").and_then(Value::as_str).unwrap_or("")));
    format!("{index}: [{kind}] {}{preferred}{disabled}", a["title"].as_str().unwrap_or(""))
}

pub fn hover_text(contents: &Value) -> String {
    match contents {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(hover_text).collect::<Vec<_>>().join("\n\n"),
        Value::Object(o) => o.get("value").and_then(Value::as_str).map_or_else(|| contents.to_string(), String::from),
        other => other.to_string(),
    }
}

/// Preview lines for a workspace edit (`file: N edits`, `CREATE:`, `RENAME: a ❯ b`, `DELETE:`).
pub fn workspace_edit_preview(edit: &Value, cwd: &Path) -> Vec<String> {
    let rel = |uri: &str| format_rel_cwd(&uri_to_file(uri), cwd, false);
    let plural = |n: usize| format!("{n} edit{}", if n > 1 { "s" } else { "" });
    let mut out = Vec::new();
    if let Some(Value::Object(changes)) = edit.get("changes") { for (uri, edits) in changes { out.push(format!("{}: {}", rel(uri), plural(edits.as_array().map_or(0, Vec::len)))); } }
    for c in edit.get("documentChanges").and_then(Value::as_array).into_iter().flatten() {
        match c.get("kind").and_then(Value::as_str) {
            Some("create") => out.push(format!("CREATE: {}", rel(c["uri"].as_str().unwrap_or("")))),
            Some("rename") => out.push(format!("RENAME: {} {CURSOR} {}", rel(c["oldUri"].as_str().unwrap_or("")), rel(c["newUri"].as_str().unwrap_or("")))),
            Some("delete") => out.push(format!("DELETE: {}", rel(c["uri"].as_str().unwrap_or("")))),
            _ => if let Some(edits) = c.get("edits").and_then(Value::as_array) { out.push(format!("{}: {}", rel(c.pointer("/textDocument/uri").and_then(Value::as_str).unwrap_or("")), plural(edits.len()))); },
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn formats_a_diagnostic_like_omp() {
        let d = json!({"range": {"start": {"line": 2, "character": 4}}, "severity": 2, "source": "ts", "code": 2322, "message": "bad\nfor further information visit https://x"});
        assert_eq!(format_diagnostic(&d, "a.ts"), "a.ts:3:5 [warning] [ts] bad (2322)");
        assert_eq!(summary(&[d.clone(), json!({"message": "x"})]), "1 error(s), 1 warning(s)");
        assert_eq!(summary(&[]), "no issues");
    }
    #[test] fn groups_messages_by_file() {
        let m = ["a.ts:1:1 [error] x", "src/b.ts:2:3 [warning] y", "a.ts:4:1 [error] z"].map(String::from);
        assert_eq!(group_messages(&m), "# a.ts\n  1:1 [error] x\n  4:1 [error] z\n\n# src/\n## b.ts\n  2:3 [warning] y");
    }
    #[test] fn normalises_location_links() {
        let l = locations(&json!([{"targetUri": "file:///a", "targetSelectionRange": {"start": {"line": 1, "character": 2}}, "targetRange": {}}, {"uri": "file:///b", "range": {}}]));
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["range"]["start"]["line"], 1);
    }
    #[test] fn renders_document_symbols_hierarchically() {
        let mut out = Vec::new();
        document_symbol(&json!({"name": "A", "kind": 5, "range": {"start": {"line": 0}}, "children": [{"name": "m", "kind": 6, "detail": "(): void", "range": {"start": {"line": 2}}}]}), 0, &mut out);
        assert_eq!(out, ["⬢ A @ line 1", "  ⟲ m (): void @ line 3"]);
    }
    #[test] fn preview_lines() {
        let e = json!({"changes": {"file:///w/a.ts": [{}, {}]}, "documentChanges": [{"kind": "rename", "oldUri": "file:///w/a.ts", "newUri": "file:///w/b.ts"}]});
        assert_eq!(workspace_edit_preview(&e, Path::new("/w")), ["a.ts: 2 edits", "RENAME: a.ts ❯ b.ts"]);
    }
}
