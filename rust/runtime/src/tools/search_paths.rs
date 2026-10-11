//! Path-list parsing shared by `grep` and `glob`, ported from omp's `path-utils.ts`.
use super::read_selector;
use std::path::{Path, PathBuf};

pub fn has_glob(s: &str) -> bool { s.contains(['*', '?', '[', '{']) }

pub fn normalize_input(s: &str) -> String {
    let t = s.trim();
    t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).filter(|_| t.len() >= 2).unwrap_or(t).to_string()
}

/// `path` may be one string or a JSON-array string such as `["a","b"]`.
pub fn to_path_list(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else { return Vec::new() };
    if raw.starts_with('[') && raw.ends_with(']') {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(raw) { return list; }
    }
    vec![raw.to_string()]
}

pub fn resolve_to_cwd(p: &str, cwd: &Path) -> PathBuf {
    let expanded = if p == "~" { dirs::home_dir().unwrap_or_default() }
        else if let Some(rest) = p.strip_prefix("~/") { dirs::home_dir().unwrap_or_default().join(rest) }
        else { PathBuf::from(p) };
    if expanded.is_absolute() { expanded } else { cwd.join(expanded) }
}

/// Collapses `.` / `..` lexically (no filesystem access), like `path.resolve`.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => { out.pop(); },
            std::path::Component::CurDir => {},
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Display path: relative to cwd when inside it, else absolute; always `/`-separated.
pub fn format_rel_cwd(path: &Path, cwd: &Path, trailing_slash: bool) -> String {
    let abs = lexical(&if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) });
    let mut shown = match abs.strip_prefix(lexical(cwd)) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => abs.to_string_lossy().into_owned(),
    }.replace('\\', "/");
    if trailing_slash && shown != "." && !shown.ends_with('/') { shown.push('/'); }
    shown
}

fn first_glob_segment(segments: &[&str]) -> Option<usize> { segments.iter().position(|s| has_glob(s)) }

/// `src/**/*.ts` -> (`src`, Some(`**/*.ts`)); a glob in the first segment gives base `.`.
pub fn parse_search_path(p: &str) -> (String, Option<String>) {
    let norm = p.replace('\\', "/");
    let segs: Vec<&str> = norm.split('/').collect();
    match first_glob_segment(&segs) {
        None => (norm, None),
        Some(0) => (".".into(), Some(norm)),
        Some(i) => (segs[..i].join("/"), Some(segs[i..].join("/"))),
    }
}

/// glob-tool pattern: (base, glob, has_glob). A glob in the first segment recurses.
pub fn parse_find_pattern(p: &str) -> (String, String, bool) {
    let norm = p.replace('\\', "/");
    let segs: Vec<&str> = norm.split('/').collect();
    match first_glob_segment(&segs) {
        None => (norm, "**/*".into(), false),
        Some(0) => (".".into(), if norm.starts_with("**/") { norm } else { format!("**/{norm}") }, true),
        Some(i) => (segs[..i].join("/"), segs[i..].join("/"), true),
    }
}

/// A path with glob characters that exists literally (Next.js `[id]` routes) is not a glob.
pub fn parse_search_path_literal_first(p: &str, cwd: &Path) -> (String, Option<String>) {
    if has_glob(p) && resolve_to_cwd(p, cwd).symlink_metadata().is_ok() { return (p.replace('\\', "/"), None); }
    parse_search_path(p)
}

/// A glob spelled with no directory part (`*.ts`) matches at any depth.
pub fn is_bare_glob(raw: &str, glob: &Option<String>) -> bool { glob.is_some() && !raw.contains(['/', '\\']) }

fn top_level_delims(entry: &str, mode: char) -> Vec<usize> {
    let (mut depth, mut out, mut esc) = (0i32, Vec::new(), false);
    for (i, ch) in entry.char_indices() {
        if esc { esc = false; continue; }
        match ch {
            '\\' => esc = true,
            '{' => depth += 1,
            '}' => depth = (depth - 1).max(0),
            c if depth == 0 => {
                let hit = match mode { ',' => c == ',', ';' => c == ';', 'w' => c.is_whitespace(), _ => c == ',' || c == ';' || c.is_whitespace() };
                if hit { out.push(i); }
            },
            _ => {},
        }
    }
    out
}

fn split_at_delims(entry: &str, mode: char) -> Vec<String> {
    let (mut parts, mut start) = (Vec::new(), 0);
    for i in top_level_delims(entry, mode) { parts.push(entry[start..i].to_string()); start = i + entry[i..].chars().next().map_or(1, char::len_utf8); }
    parts.push(entry[start..].to_string());
    parts
}

/// `splitter` maps an entry to its base path (parse_search_path / parse_find_pattern).
fn part_resolves(entry: &str, cwd: &Path, splitter: &dyn Fn(&str) -> String) -> bool {
    let peeled = peel(entry).0;
    std::fs::metadata(resolve_to_cwd(&splitter(&peeled), cwd)).is_ok()
}

/// Splits `a:1-2`-style selectors off a path (line ranges only).
pub fn peel(entry: &str) -> (String, Option<String>) {
    for at in entry.match_indices(':').map(|(i, _)| i).rev().take(1) {
        let sel = &entry[at + 1..];
        if !entry[..at].is_empty() && matches!(read_selector::parse(sel), Ok(Some(_))) { return (entry[..at].to_string(), Some(sel.to_string())); }
    }
    (entry.to_string(), None)
}

fn try_split(entry: &str, cwd: &Path, splitter: &dyn Fn(&str) -> String, mode: char, need: &str) -> Option<Vec<String>> {
    let raw = split_at_delims(entry, mode);
    if raw.len() < 2 { return None; }
    let parts: Vec<String> = raw.iter().map(|p| normalize_input(p)).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || (parts.len() < 2 && raw.len() == parts.len()) { return None; }
    if need != "none" {
        let ok: Vec<bool> = parts.iter().map(|p| part_resolves(p, cwd, splitter)).collect();
        if !(if need == "all" { ok.iter().all(|x| *x) } else { ok.iter().any(|x| *x) }) { return None; }
    }
    Some(parts)
}

/// Splits one flattened entry (`a;b`, `a, b`) into several paths; real names containing delimiters win.
pub fn split_delimited(entry: &str, cwd: &Path, splitter: &dyn Fn(&str) -> String) -> Option<Vec<String>> {
    let entry = normalize_input(entry);
    if top_level_delims(&entry, 'm').is_empty() { return None; }
    if resolve_to_cwd(&entry, cwd).symlink_metadata().is_ok() { return None; }
    let (peeled, sel) = peel(&entry);
    if sel.is_some() && resolve_to_cwd(&peeled, cwd).symlink_metadata().is_ok() { return None; }
    if !has_glob(&peeled) && part_resolves(&entry, cwd, splitter) { return None; }
    try_split(&entry, cwd, splitter, ';', "none").or_else(|| try_split(&entry, cwd, splitter, ',', "some"))
        .or_else(|| try_split(&entry, cwd, splitter, 'w', "all")).or_else(|| try_split(&entry, cwd, splitter, 'm', "all"))
}

pub fn expand_delimited(entries: &[String], cwd: &Path, splitter: &dyn Fn(&str) -> String) -> Vec<String> {
    entries.iter().flat_map(|e| split_delimited(e, cwd, splitter).unwrap_or_else(|| vec![normalize_input(e)])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_search_and_find_patterns() {
        assert_eq!(parse_search_path("src/**/*.ts"), ("src".into(), Some("**/*.ts".into())));
        assert_eq!(parse_search_path("*.ts"), (".".into(), Some("*.ts".into())));
        assert_eq!(parse_search_path("src"), ("src".into(), None));
        assert_eq!(parse_find_pattern("*.ts"), (".".into(), "**/*.ts".into(), true));
        assert_eq!(parse_find_pattern("src/*"), ("src".into(), "*".into(), true));
        assert_eq!(parse_find_pattern("src"), ("src".into(), "**/*".into(), false));
        assert!(is_bare_glob("*.ts", &Some("*.ts".into())) && !is_bare_glob("./*.ts", &Some("*.ts".into())));
    }
    #[test] fn path_lists_and_delimiters() {
        assert_eq!(to_path_list(Some("[\"a\",\"b\"]")), vec!["a", "b"]);
        assert_eq!(to_path_list(Some("a")), vec!["a"]);
        let cwd = std::env::temp_dir();
        let split = |p: &str| parse_search_path(p).0;
        assert_eq!(expand_delimited(&["x;y".into()], &cwd, &split), vec!["x", "y"]);
        assert_eq!(expand_delimited(&["\"solo\"".into()], &cwd, &split), vec!["solo"]);
    }
    #[test] fn displays_paths_relative_to_cwd() {
        let cwd = Path::new("/w/proj");
        assert_eq!(format_rel_cwd(Path::new("/w/proj/src/a.rs"), cwd, false), "src/a.rs");
        assert_eq!(format_rel_cwd(Path::new("/other/x"), cwd, false), "/other/x");
        assert_eq!(format_rel_cwd(Path::new("/w/proj/src"), cwd, true), "src/");
    }
}
