//! omp `glob`: path/pattern lists, newest-first ordering, grouped output with limit notices.
use super::{search_paths::*, search_walk, tree_output};
use std::{path::Path, time::SystemTime};

const DEFAULT_LIMIT: usize = 200;
const MAX_OUTPUT_BYTES: usize = 51_200;

pub struct Input { pub path: Option<String>, pub hidden: Option<bool>, pub gitignore: Option<bool>, pub limit: Option<f64> }

fn base_of(entry: &str) -> String { parse_find_pattern(entry).0 }

pub fn run(root: &Path, input: Input) -> Result<String, String> {
    let list = to_path_list(input.path.as_deref());
    let raw = expand_delimited(&if list.is_empty() { vec![".".into()] } else { list }, root, &base_of);
    let mut patterns: Vec<String> = raw.iter().map(|p| normalize_input(p).replace('\\', "/")).collect();
    if patterns.iter().any(|p| !p.is_empty() && p.chars().all(|c| c == '/')) { return Err("Searching from root directory '/' is not allowed".into()); }
    if patterns.iter().any(String::is_empty) { return Err("`path` must contain non-empty globs or paths".into()); }
    let mut missing = Vec::new();
    if patterns.len() > 1 {
        let (valid, gone): (Vec<_>, Vec<_>) = patterns.into_iter().partition(|p| std::fs::metadata(resolve_to_cwd(&base_of(p), root)).is_ok());
        if valid.is_empty() { return Err(format!("Path not found: {}", gone.join(", "))); }
        patterns = valid;
        missing = gone;
    }
    let requested = input.limit.unwrap_or(DEFAULT_LIMIT as f64);
    if !requested.is_finite() || requested <= 0.0 { return Err("Limit must be a positive number".into()); }
    let limit = (requested.floor() as usize).clamp(1, DEFAULT_LIMIT);
    let clamp_notice = (requested > DEFAULT_LIMIT as f64).then(|| format!("Requested limit {requested} clamped to the max of {DEFAULT_LIMIT}"));
    let opts = search_walk::Opts { hidden: input.hidden.unwrap_or(true), gitignore: input.gitignore.unwrap_or(true), include_dirs: true, bare_glob: false };
    let mut found: Vec<(String, SystemTime)> = Vec::new();
    for pat in &patterns {
        let (base, glob, has_glob) = parse_find_pattern(pat);
        let base_abs = resolve_to_cwd(&base, root);
        if base_abs == Path::new("/") { return Err("Searching from root directory '/' is not allowed".into()); }
        let meta = std::fs::metadata(&base_abs).map_err(|_| format!("Path not found: {}", format_rel_cwd(&base_abs, root, false)))?;
        if has_glob && !meta.is_dir() { return Err(format!("Path is not a directory: {}", base_abs.display())); }
        if !has_glob && meta.is_file() { found.push((format_rel_cwd(&base_abs, root, false), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH))); continue; }
        let mut entries = search_walk::walk(&base_abs, Some(&glob), opts)?;
        entries.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.rel.cmp(&b.rel)));
        entries.truncate(limit);
        for e in entries { found.push((format_rel_cwd(&e.abs, root, e.is_dir), e.mtime)); }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|(p, _)| seen.insert(p.clone()));
    found.sort_by(|a, b| b.1.cmp(&a.1)); // stable: keeps per-target path order on ties
    let missing_note = (!missing.is_empty()).then(|| format!("Skipped missing paths: {}", missing.join(", ")));
    if found.is_empty() {
        let mut parts = vec!["No files found matching pattern".to_string()];
        parts.extend(missing_note);
        return Ok(parts.join("\n"));
    }
    let reached = found.len() >= limit;
    found.truncate(limit);
    let paths: Vec<String> = found.into_iter().map(|f| f.0).collect();
    let mut text = tree_output::format_grouped_paths(&paths);
    let mut trailing: Vec<String> = Vec::new();
    trailing.extend(clamp_notice);
    trailing.extend(missing_note);
    if !trailing.is_empty() { text = format!("{text}\n\n{}", trailing.join("\n")); }
    let mut notices: Vec<String> = Vec::new();
    if text.len() > MAX_OUTPUT_BYTES {
        let total = text.split('\n').count();
        let (mut used, mut kept) = (0usize, 0usize);
        for l in text.split('\n') { if used + l.len() + usize::from(kept > 0) > MAX_OUTPUT_BYTES { break; } used += l.len() + usize::from(kept > 0); kept += 1; }
        text = text.split('\n').take(kept).collect::<Vec<_>>().join("\n");
        notices.push(format!("Showing lines 1-{kept} of {total} ({:.1}KB limit)", MAX_OUTPUT_BYTES as f64 / 1024.0));
    }
    if reached {
        let suggestion = (limit * 2).min(DEFAULT_LIMIT);
        notices.push(if suggestion > limit { format!("{limit} results limit reached. Use limit={suggestion} for more") } else { format!("{limit} results limit reached") });
    }
    if !notices.is_empty() { text.push_str(&format!("\n\n[{}]", notices.join(". "))); }
    Ok(text)
}
