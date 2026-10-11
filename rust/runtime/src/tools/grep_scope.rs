//! Resolves `grep`'s `path` argument into search targets (omp `resolveToolSearchScope`, fan-out flavour).
use super::{read_selector, search_paths::*};
use std::path::{Path, PathBuf};

pub struct Target { pub base: PathBuf, pub glob: Option<String>, pub bare: bool }

pub struct Scope {
    pub search_path: PathBuf,
    pub scope_path: String,
    pub is_dir: bool,
    pub targets: Vec<Target>,
    pub exact_files: Option<Vec<PathBuf>>,
    pub multi: bool,
    pub missing: Vec<String>,
    /// absolute file -> requested line ranges
    pub ranges: Vec<(PathBuf, Vec<read_selector::Range>)>,
}

fn common_base(paths: &[PathBuf]) -> PathBuf {
    let mut common: Vec<_> = lexical(&paths[0]).components().map(|c| c.as_os_str().to_owned()).collect();
    for p in &paths[1..] {
        let parts: Vec<_> = lexical(p).components().map(|c| c.as_os_str().to_owned()).collect();
        let n = common.iter().zip(&parts).take_while(|(a, b)| a == b).count();
        common.truncate(n);
    }
    common.iter().collect()
}

fn base_of(entry: &str) -> String { parse_search_path(entry).0 }

pub fn resolve(raw: &[String], cwd: &Path) -> Result<Scope, String> {
    let mut entries: Vec<String> = Vec::new();
    let mut ranges: Vec<(PathBuf, Vec<read_selector::Range>)> = Vec::new();
    for entry in expand_delimited(raw, cwd, &base_of) {
        if entry.is_empty() { return Err("Search scope entries must be non-empty paths or globs".into()); }
        let lower = entry.to_ascii_lowercase();
        if ["http://", "https://", "ftp://", "ws://", "wss://"].iter().any(|p| lower.starts_with(p)) {
            return Err(format!("Cannot search external URL: {entry}. Use `read` to fetch web content, then search the returned text."));
        }
        let (clean, sel) = read_selector::split(&entry, |p| resolve_to_cwd(p, cwd))?;
        if clean != entry {
            if sel.raw || sel.tail.is_some() { return Err(format!("path entry \"{entry}\" — only line-range selectors like \":50-100\" are supported (no \":raw\"/\":conflicts\")")); }
            let abs = resolve_to_cwd(&clean, cwd);
            if has_glob(&clean) && abs.symlink_metadata().is_err() { return Err(format!("Line-range selector requires a single file, not a glob: {entry}")); }
            match std::fs::metadata(&abs) {
                Err(_) => return Err(format!("Path not found for line-range selector: {entry}")),
                Ok(m) if m.is_dir() => return Err(format!("Line-range selector requires a single file: {entry} is a directory")),
                Ok(_) => ranges.push((lexical(&abs), sel.ranges)),
            }
        }
        entries.push(clean);
    }
    let mut missing = Vec::new();
    if entries.len() > 1 {
        let (valid, gone): (Vec<_>, Vec<_>) = entries.iter().cloned().partition(|e| resolve_to_cwd(&base_of(e), cwd).symlink_metadata().is_ok() || std::fs::metadata(resolve_to_cwd(&base_of(e), cwd)).is_ok());
        if valid.is_empty() { return Err(format!("Path not found: {}", gone.join(", "))); }
        entries = valid;
        missing = gone;
    }
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.clone()));
    let multi_entries = entries.len() > 1;
    let (search_path, scope_path, targets, exact_files);
    if !multi_entries {
        let (base, glob) = parse_search_path_literal_first(&entries[0], cwd);
        search_path = resolve_to_cwd(&base, cwd);
        scope_path = format_rel_cwd(&search_path, cwd, false);
        targets = vec![Target { base: search_path.clone(), bare: is_bare_glob(&entries[0], &glob), glob }];
        exact_files = None;
    } else {
        let parsed: Vec<(String, (String, Option<String>))> = entries.iter().map(|e| (e.clone(), parse_search_path_literal_first(e, cwd))).collect();
        let bases: Vec<PathBuf> = parsed.iter().map(|(_, (b, _))| resolve_to_cwd(b, cwd)).collect();
        let all_files = parsed.iter().zip(&bases).all(|((_, (_, g)), b)| g.is_none() && b.is_file());
        search_path = common_base(&bases);
        scope_path = entries.iter().map(|e| format_rel_cwd(Path::new(e), cwd, e.ends_with(['/', '\\']))).collect::<Vec<_>>().join(", ");
        exact_files = all_files.then(|| bases.clone());
        targets = parsed.iter().zip(&bases).map(|((raw, (_, glob)), b)| Target { base: b.clone(), bare: is_bare_glob(raw, glob), glob: glob.clone() }).collect();
    }
    let is_dir = std::fs::metadata(&search_path).map(|m| m.is_dir()).map_err(|_| {
        let hint = if raw.len() > 1 { " (`path` list entries must each exist relative to cwd)" } else { "" };
        format!("Path not found: {scope_path}{hint}")
    })?;
    Ok(Scope { search_path, scope_path, is_dir, multi: multi_entries, targets, exact_files, missing, ranges })
}
