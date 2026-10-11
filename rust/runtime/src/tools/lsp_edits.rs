//! Applies LSP text edits and workspace edits to disk (omp `edits.ts`): UTF-16 positions, overlap checks, rollback.
use super::{lsp_client::uri_to_file, search_paths::format_rel_cwd};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};

/// What a workspace edit did, for reconciling open documents afterwards.
#[derive(Default)]
pub struct Applied { pub summary: Vec<String>, pub changed: Vec<PathBuf>, pub created: Vec<PathBuf>, pub deleted: Vec<PathBuf>, pub renamed: Vec<(PathBuf, PathBuf)> }

fn pos(v: &Value, key: &str) -> (usize, usize) {
    let p = v.get(key);
    (p.and_then(|p| p.get("line")).and_then(Value::as_u64).unwrap_or(0) as usize, p.and_then(|p| p.get("character")).and_then(Value::as_u64).unwrap_or(0) as usize)
}

/// Byte offset of (line, UTF-16 column); columns past the end of a line clamp to it.
fn offset(text: &str, starts: &[usize], line: usize, col: usize) -> usize {
    let Some(&start) = starts.get(line) else { return text.len() };
    let end = starts.get(line + 1).map_or(text.len(), |e| e - 1);
    let (mut units, mut at) = (0, start);
    for ch in text[start..end].chars() { if units >= col { break; } units += ch.len_utf16(); at += ch.len_utf8(); }
    at
}

fn range_label(e: &Value) -> String {
    let (s, t) = (pos(&e["range"], "start"), pos(&e["range"], "end"));
    format!("{}:{}-{}:{}", s.0 + 1, s.1 + 1, t.0 + 1, t.1 + 1)
}

/// Validates then applies `edits` (all positions refer to the original text).
pub fn apply_text_edits(content: &str, edits: &[Value]) -> Result<String, String> {
    if edits.iter().any(|e| e.get("insertTextFormat").and_then(Value::as_u64) == Some(2)) { return Err("snippet-formatted LSP edits are unsupported".into()); }
    let mut starts = vec![0usize];
    for (i, b) in content.bytes().enumerate() { if b == b'\n' { starts.push(i + 1); } }
    let mut spans: Vec<(usize, usize, usize, &Value)> = edits.iter().enumerate().map(|(i, e)| {
        let (s, t) = (pos(&e["range"], "start"), pos(&e["range"], "end"));
        (offset(content, &starts, s.0, s.1), offset(content, &starts, t.0, t.1), i, e)
    }).collect();
    spans.sort_by_key(|s| (s.0, s.2));
    let mut unique: Vec<(usize, usize, usize, &Value)> = Vec::new();
    for s in spans {
        if let Some(last) = unique.last() {
            if last.0 != last.1 && last.0 == s.0 && last.1 == s.1 && last.3.get("newText") == s.3.get("newText") { continue; }
            if s.0 < last.1 { return Err(format!("overlapping LSP edits: {} conflicts with {}; LSP produced inconsistent edits", range_label(last.3), range_label(s.3))); }
        }
        unique.push(s);
    }
    let mut out = String::with_capacity(content.len());
    let mut at = 0;
    for (s, e, _, edit) in unique { out.push_str(&content[at..s]); out.push_str(edit.get("newText").and_then(Value::as_str).unwrap_or("")); at = e; }
    out.push_str(&content[at..]);
    Ok(out)
}

fn read(path: &Path) -> Result<String, String> {
    let m = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !m.is_file() { return Err(format!("{} is not a regular file", path.display())); }
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn plural_edits(n: usize) -> String { format!("{n} edit{}", if n == 1 { "" } else { "s" }) }

/// Applies a `WorkspaceEdit`. Every text batch is validated before the first write.
pub fn apply_workspace_edit_ops(edit: &Value, cwd: &Path) -> Result<Applied, String> {
    let mut ops: Vec<(String, Value)> = Vec::new(); // (kind, payload): "text" with {uri,edits}, or create/rename/delete
    if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
        for c in changes {
            match c.get("kind").and_then(Value::as_str) {
                Some(kind) => ops.push((kind.to_string(), c.clone())),
                None => ops.push(("text".into(), serde_json::json!({"uri": c.pointer("/textDocument/uri"), "edits": c.get("edits")}))),
            }
        }
    } else if let Some(Value::Object(changes)) = edit.get("changes") {
        for (uri, edits) in changes { ops.push(("text".into(), serde_json::json!({"uri": uri, "edits": edits}))); }
    }
    let mut batches: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (kind, c) in &ops {
        if kind == "text" { if let (Some(uri), Some(edits)) = (c["uri"].as_str(), c["edits"].as_array()) { batches.entry(uri.to_string()).or_default().extend(edits.iter().cloned()); } }
    }
    let mut computed: BTreeMap<String, String> = BTreeMap::new();
    for (uri, edits) in &batches {
        let path = uri_to_file(uri);
        let creates = ops.iter().any(|(k, c)| k == "create" && c["uri"].as_str() == Some(uri));
        let base = if creates && !path.exists() { String::new() } else { read(&path)? };
        computed.insert(uri.clone(), apply_text_edits(&base, edits)?);
    }
    let mut applied = Applied::default();
    let rel = |p: &Path| format_rel_cwd(p, cwd, false);
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
    let flush = |uri: &str, applied: &mut Applied, written: &mut std::collections::HashSet<String>| -> Result<(), String> {
        if !written.insert(uri.to_string()) { return Ok(()); }
        let Some(text) = computed.get(uri) else { return Ok(()) };
        let path = uri_to_file(uri);
        fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        applied.summary.push(format!("Applied {} to {}", plural_edits(batches[uri].len()), rel(&path)));
        applied.changed.push(path);
        Ok(())
    };
    for (kind, c) in &ops {
        match kind.as_str() {
            "text" => { if let Some(uri) = c["uri"].as_str() { if !ops.iter().any(|(k, o)| k == "create" && o["uri"].as_str() == Some(uri)) { flush(uri, &mut applied, &mut written)?; } } },
            "create" => {
                let uri = c["uri"].as_str().unwrap_or_default();
                let path = uri_to_file(uri);
                let (overwrite, ignore) = (c.pointer("/options/overwrite").and_then(Value::as_bool) == Some(true), c.pointer("/options/ignoreIfExists").and_then(Value::as_bool) == Some(true));
                if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                if path.exists() && !overwrite { if ignore { continue; } return Err(format!("create target already exists: {}", rel(&path))); }
                fs::write(&path, computed.get(uri).map_or("", String::as_str)).map_err(|e| e.to_string())?;
                written.insert(uri.to_string());
                applied.summary.push(format!("Created {}", rel(&path)));
                applied.created.push(path);
            },
            "rename" => {
                let (old, new) = (uri_to_file(c["oldUri"].as_str().unwrap_or_default()), uri_to_file(c["newUri"].as_str().unwrap_or_default()));
                flush(c["oldUri"].as_str().unwrap_or_default(), &mut applied, &mut written)?;
                if let Some(parent) = new.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                if old != new && new.exists() {
                    if c.pointer("/options/ignoreIfExists").and_then(Value::as_bool) == Some(true) && c.pointer("/options/overwrite").and_then(Value::as_bool) != Some(true) { continue; }
                    if c.pointer("/options/overwrite").and_then(Value::as_bool) != Some(true) { return Err(format!("rename target already exists: {}", rel(&new))); }
                }
                fs::rename(&old, &new).map_err(|e| format!("{}: {e}", old.display()))?;
                applied.summary.push(format!("Renamed {} → {}", rel(&old), rel(&new)));
                applied.renamed.push((old, new));
            },
            "delete" => {
                let path = uri_to_file(c["uri"].as_str().unwrap_or_default());
                let recursive = c.pointer("/options/recursive").and_then(Value::as_bool) == Some(true);
                let result = match fs::symlink_metadata(&path) { Ok(m) if m.is_dir() => if recursive { fs::remove_dir_all(&path) } else { fs::remove_dir(&path) }, Ok(_) => fs::remove_file(&path), Err(e) => Err(e) };
                match result { Ok(()) => { applied.summary.push(format!("Deleted {}", rel(&path))); applied.deleted.push(path); }, Err(e) if e.kind() == std::io::ErrorKind::NotFound && c.pointer("/options/ignoreIfNotExists").and_then(Value::as_bool) == Some(true) => {}, Err(e) => return Err(format!("{}: {e}", path.display())) }
            },
            _ => {},
        }
    }
    for uri in batches.keys() { flush(uri, &mut applied, &mut written)?; }
    Ok(applied)
}

pub fn apply_workspace_edit(edit: &Value, cwd: &Path) -> Result<Vec<String>, String> { apply_workspace_edit_ops(edit, cwd).map(|a| a.summary) }

/// Applies per-file edits from a rename-file preflight, then moves `source` to `dest`; restores every file on failure.
pub fn apply_edits_then_rename(edits: &BTreeMap<PathBuf, Vec<Value>>, source: &Path, dest: &Path) -> Result<Vec<String>, String> {
    let mut snapshots: Vec<(PathBuf, String)> = Vec::new();
    let mut lines = Vec::new();
    let result = (|| -> Result<(), String> {
        for (path, edits) in edits {
            let before = read(path)?;
            let after = apply_text_edits(&before, edits)?;
            snapshots.push((path.clone(), before));
            fs::write(path, after).map_err(|e| e.to_string())?;
            lines.push(path.clone());
        }
        if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::rename(source, dest).map_err(|e| e.to_string())
    })();
    if let Err(e) = result { for (p, text) in snapshots { let _ = fs::write(p, text); } return Err(e); }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn edit(l1: u64, c1: u64, l2: u64, c2: u64, text: &str) -> Value { json!({"range": {"start": {"line": l1, "character": c1}, "end": {"line": l2, "character": c2}}, "newText": text}) }
    #[test] fn applies_edits_against_the_original_positions() {
        let out = apply_text_edits("hello world\nsecond line\n", &[edit(1, 0, 1, 6, "2nd"), edit(0, 6, 0, 11, "rust")]).unwrap();
        assert_eq!(out, "hello rust\n2nd line\n");
    }
    #[test] fn columns_are_utf16_units() {
        // 😀 is two UTF-16 units: the "b" sits at column 3
        assert_eq!(apply_text_edits("a😀b\n", &[edit(0, 3, 0, 4, "X")]).unwrap(), "a😀X\n");
    }
    #[test] fn same_position_inserts_keep_array_order_and_overlaps_are_rejected() {
        assert_eq!(apply_text_edits("x\n", &[edit(0, 0, 0, 0, "A"), edit(0, 0, 0, 0, "B")]).unwrap(), "ABx\n");
        let err = apply_text_edits("abcdef\n", &[edit(0, 0, 0, 4, "1"), edit(0, 2, 0, 5, "2")]).unwrap_err();
        assert_eq!(err, "overlapping LSP edits: 1:1-1:5 conflicts with 1:3-1:6; LSP produced inconsistent edits");
    }
    #[test] fn snippets_and_crlf() {
        assert_eq!(apply_text_edits("a\n", &[json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}, "newText": "$1", "insertTextFormat": 2})]).unwrap_err(), "snippet-formatted LSP edits are unsupported");
        assert_eq!(apply_text_edits("one\r\ntwo\r\n", &[edit(1, 0, 1, 3, "2")]).unwrap(), "one\r\n2\r\n");
    }
    #[test] fn workspace_edit_creates_renames_edits_and_deletes() {
        let d = std::env::temp_dir().join(format!("lspedit-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.txt"), "old\n").unwrap();
        fs::write(d.join("gone.txt"), "x").unwrap();
        let uri = |n: &str| super::super::lsp_client::file_to_uri(&d.join(n));
        let we = json!({"documentChanges": [
            {"textDocument": {"uri": uri("a.txt"), "version": null}, "edits": [edit(0, 0, 0, 3, "new")]},
            {"kind": "create", "uri": uri("b.txt")},
            {"kind": "rename", "oldUri": uri("a.txt"), "newUri": uri("c.txt")},
            {"kind": "delete", "uri": uri("gone.txt")}]});
        let applied = apply_workspace_edit_ops(&we, &d).unwrap();
        assert_eq!(applied.summary, ["Applied 1 edit to a.txt", "Created b.txt", "Renamed a.txt → c.txt", "Deleted gone.txt"]);
        assert_eq!(fs::read_to_string(d.join("c.txt")).unwrap(), "new\n");
        assert!(d.join("b.txt").exists() && !d.join("gone.txt").exists() && !d.join("a.txt").exists());
        fs::remove_dir_all(d).ok();
    }
    #[test] fn invalid_batches_write_nothing() {
        let d = std::env::temp_dir().join(format!("lspedit2-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("ok.txt"), "abc\n").unwrap();
        fs::write(d.join("bad.txt"), "abcdef\n").unwrap();
        let uri = |n: &str| super::super::lsp_client::file_to_uri(&d.join(n));
        let we = json!({"changes": {uri("bad.txt"): [edit(0, 0, 0, 4, "1"), edit(0, 2, 0, 5, "2")], uri("ok.txt"): [edit(0, 0, 0, 1, "Z")]}});
        assert!(apply_workspace_edit_ops(&we, &d).is_err());
        assert_eq!(fs::read_to_string(d.join("ok.txt")).unwrap(), "abc\n");
        fs::remove_dir_all(d).ok();
    }
}
