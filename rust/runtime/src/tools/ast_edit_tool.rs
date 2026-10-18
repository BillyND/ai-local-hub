//! omp `ast_edit`: structural rewrites staged as a proposal, applied by `resolve` or dropped by `reject`.
use super::{ast_common::{self as common, plural, Resolution}, cancel, grep_scope, hashline_edit::write_atomic, tree_output};
use ast_grep_core::{source::Edit, tree_sitter::LanguageExt, MatchStrictness};
use pi_ast::ops;
use pi_edit::EditStore;
use std::{collections::{BTreeMap, HashMap, HashSet}, path::{Path, PathBuf}, sync::Mutex};

const MAX_FILES: usize = 1000;
pub const PREVIEW_NOTICE: &str = "Staged as a proposal — files NOT modified yet. To apply: call `resolve` with a one-sentence reason. To discard: call `reject`.";

pub struct Op { pub pat: String, pub out: String }
pub struct Input { pub ops: Vec<Op>, pub paths: Vec<String> }

/// A staged preview waiting for `resolve` / `reject`.
pub struct Pending { label: String, rewrites: Vec<(String, String)>, paths: Vec<String>, total: usize, files: usize, counts: BTreeMap<String, usize> }
pub type PendingList = Mutex<std::collections::VecDeque<Pending>>;

struct Change { display: String, abs: PathBuf, before: String, after: String, line: usize, column: usize }
struct Outcome { changes: Vec<Change>, counts: BTreeMap<String, usize>, total: usize, touched: usize, limit_reached: bool, parse_errors: Vec<String>, missing: Option<String> }

fn run_once(root: &Path, rewrites: &[(String, String)], paths: &[String], dry_run: bool) -> Result<Outcome, String> {
    let scope = grep_scope::resolve(paths, root)?;
    let (cands, oversized) = common::collect(&scope, root, None)?;
    if cands.is_empty() {
        let why = common::oversized_note(&oversized).map_or(String::new(), |n| format!(". {n}"));
        return Err(format!("ast_edit found no supported source files for the given path/glob{why}"));
    }
    let Resolution { files, languages, missing } = common::resolve(cands, None);
    let mut parse_errors: Vec<String> = Vec::new();
    let mut rules: Vec<(String, String, HashMap<String, ast_grep_core::matcher::Pattern>, HashMap<String, String>)> = Vec::new();
    for (pat, out) in rewrites {
        let (mut ok, mut bad) = (HashMap::new(), HashMap::new());
        for (key, lang) in &languages {
            match ops::compile_pattern(pat, None, &MatchStrictness::Smart, *lang) { Ok(p) => { ok.insert(key.clone(), p); }, Err(e) => { bad.insert(key.clone(), e.to_string()); } }
        }
        if ok.is_empty() && !languages.is_empty() {
            let mut entries: Vec<_> = bad.iter().collect();
            entries.sort();
            for (k, e) in entries { parse_errors.push(if languages.len() > 1 { format!("{pat} ({k}): {e}") } else { format!("{pat}: {e}") }); }
            continue;
        }
        rules.push((pat.clone(), out.clone(), ok, bad));
    }
    let note = [common::missing_note(&missing), common::oversized_note(&oversized)].into_iter().flatten().collect::<Vec<_>>().join("\n");
    let note = (!note.is_empty()).then_some(note);
    let mut out = Outcome { changes: Vec::new(), counts: BTreeMap::new(), total: 0, touched: 0, limit_reached: false, parse_errors, missing: note };
    if rules.is_empty() { return Ok(out); }
    let mut writes: Vec<(PathBuf, String)> = Vec::new();
    for r in &files {
        // Stopping here is safe: nothing is written until every file has been rewritten in memory.
        cancel::check()?;
        if let Some(e) = &r.lang_error { out.parse_errors.push(format!("{}: {e}", r.cand.display)); continue; }
        let Some(lang) = r.lang else { continue };
        let key = lang.canonical_name();
        let mut runnable = Vec::new();
        for (pat, rewrite, ok, bad) in &rules {
            if let Some(e) = bad.get(key) { out.parse_errors.push(format!("{pat}: {}: {e}", r.cand.display)); continue; }
            if let Some(p) = ok.get(key) { runnable.push((rewrite.as_str(), p)); }
        }
        if runnable.is_empty() { continue; }
        let source = match std::fs::read_to_string(&r.cand.abs) { Ok(s) => s, Err(e) => { out.parse_errors.push(format!("{}: {e}", r.cand.display)); continue; } };
        let ast = lang.ast_grep(&source);
        if ast.root().dfs().any(|n| n.is_error()) { out.parse_errors.push(format!("{}: parse error (syntax tree contains error nodes)", r.cand.display)); continue; }
        let (mut file_changes, mut staged): (Vec<(Change, Edit<String>)>, HashSet<(usize, usize, Vec<u8>)>) = (Vec::new(), HashSet::new());
        for (rewrite, p) in runnable {
            for m in ast.root().find_all(p.clone()) {
                let edit = m.replace_by(rewrite);
                if !staged.insert((edit.position, edit.deleted_length, edit.inserted_text.clone())) { continue; }
                let (s, after) = (m.start_pos(), String::from_utf8(edit.inserted_text.clone()).map_err(|e| format!("{}: replacement text is not valid UTF-8: {e}", r.cand.display))?);
                file_changes.push((Change { display: r.cand.display.clone(), abs: r.cand.abs.clone(), before: m.text().into_owned(), after, line: s.line() + 1, column: s.column(m.get_node()) + 1 }, edit));
            }
        }
        if file_changes.is_empty() { continue; }
        if out.touched >= MAX_FILES { out.limit_reached = true; break; }
        out.touched += 1;
        out.counts.insert(r.cand.display.clone(), file_changes.len());
        if !dry_run {
            let result = ops::apply_edits(&source, file_changes.iter().map(|(_, e)| e)).map_err(|e| e.to_string())?;
            if result != source { writes.push((r.cand.abs.clone(), result)); }
        }
        out.changes.extend(file_changes.into_iter().map(|(c, _)| c));
    }
    out.total = out.changes.len();
    for (path, text) in &writes { write_atomic(path, text).map_err(|e| format!("Failed to write {}: {e}", path.display()))?; }
    Ok(out)
}

fn first_line(s: &str) -> String { s.split('\n').next().unwrap_or("").chars().take(120).collect() }

fn issues_text(o: &Outcome) -> Vec<String> {
    let mut lines = common::format_parse_errors(&o.parse_errors);
    if let Some(n) = &o.missing { if !lines.is_empty() { lines.push(String::new()); } lines.push(n.clone()); }
    lines
}

pub fn run(root: &Path, store: &EditStore, pending: &PendingList, input: Input) -> Result<String, String> {
    for (i, op) in input.ops.iter().enumerate() { if op.pat.is_empty() { return Err(format!("`ops[{i}].pat` must be a non-empty pattern")); } }
    if input.ops.is_empty() { return Err("`ops` must include at least one op entry".into()); }
    let mut seen = HashSet::new();
    for op in &input.ops { if !seen.insert(op.pat.clone()) { return Err(format!("Duplicate rewrite pattern: {}", op.pat)); } }
    let mut rewrites: Vec<(String, String)> = input.ops.iter().map(|o| (o.pat.clone(), o.out.clone())).collect();
    rewrites.sort_by(|a, b| a.0.cmp(&b.0));
    for p in &input.paths { let l = p.to_ascii_lowercase(); if ["http://", "https://", "ftp://", "ws://", "wss://"].iter().any(|s| l.starts_with(s)) { return Err(format!("Cannot rewrite external URL: {p}. ast_edit only applies to local files.")); } }
    let result = run_once(root, &rewrites, &input.paths, true)?;
    if result.total == 0 {
        let mut out = "No replacements made".to_string();
        let extra = issues_text(&result);
        if !extra.is_empty() { out.push_str(&format!("\n{}", extra.join("\n"))); }
        return Ok(out);
    }
    let scope = grep_scope::resolve(&input.paths, root)?;
    let mut tags: HashMap<String, String> = HashMap::new();
    let mut seen_files = HashSet::new();
    for c in &result.changes { if seen_files.insert(c.display.clone()) { if let Some(t) = store.record_file(&c.abs, None) { tags.insert(c.display.clone(), t); } } }
    let files: Vec<String> = { let mut v = Vec::new(); for c in &result.changes { if !v.contains(&c.display) { v.push(c.display.clone()); } } v };
    let render = |name: &str| -> Vec<String> {
        let tagged = tags.contains_key(name);
        result.changes.iter().filter(|c| c.display == name).flat_map(|c| {
            let at = if tagged { format!("{}:", c.line) } else { format!("{}:{} ", c.line, c.column) };
            [format!("-{at}{}", first_line(&c.before)), format!("+{at}{}", first_line(&c.after))]
        }).collect()
    };
    let mut out: Vec<String> = Vec::new();
    if scope.is_dir {
        let mut emitted = false;
        for ev in tree_output::events(&files.iter().map(|n| (n.clone(), false)).collect::<Vec<_>>()) {
            match ev {
                tree_output::Event::Dir { depth, name } => { if emitted { out.push(String::new()); } emitted = true; out.push(format!("{} {name}/", "#".repeat(depth + 1))); },
                tree_output::Event::File { depth, name, key } => {
                    if emitted && depth == 0 { out.push(String::new()); }
                    emitted = true;
                    out.push(format!("{} {name}{} ({})", "#".repeat(depth + 1), tags.get(&key).map_or(String::new(), |t| format!("#{t}")), plural("replacement", result.counts[&key])));
                    out.extend(render(&key));
                },
            }
        }
    } else {
        for f in &files {
            if !out.is_empty() { out.push(String::new()); }
            if let Some(t) = tags.get(f) { out.push(format!("[{f}#{t}]")); }
            out.extend(render(f));
        }
    }
    if result.limit_reached { out.push(String::new()); out.push("Limit reached; narrow paths.".into()); }
    let extra = issues_text(&result);
    if !extra.is_empty() { out.push(String::new()); out.extend(extra); }
    let label = format!("AST Edit: {} in {}", plural("replacement", result.total), plural("file", result.touched));
    pending.lock().unwrap_or_else(|e| e.into_inner()).push_back(Pending { label, rewrites, paths: input.paths, total: result.total, files: result.touched, counts: result.counts });
    out.insert(0, String::new());
    out.insert(0, PREVIEW_NOTICE.to_string());
    Ok(out.join("\n"))
}

/// Applies the oldest staged preview. `Err` keeps the preview staged so it can be retried or rejected.
pub fn resolve(root: &Path, store: &EditStore, pending: &PendingList) -> Result<(String, bool), String> {
    let Some(p) = pending.lock().unwrap_or_else(|e| e.into_inner()).pop_front() else { return Err("No pending action to apply — `resolve` is only valid while a staged preview is pending.".into()) };
    let applied = match run_once(root, &p.rewrites, &p.paths, false) {
        Ok(a) => a,
        Err(e) => { let msg = format!("Apply failed: {e}"); pending.lock().unwrap_or_else(|x| x.into_inner()).push_front(p); return Err(msg); },
    };
    let mut fresh: Vec<String> = Vec::new();
    let mut done = HashSet::new();
    for c in &applied.changes { if done.insert(c.display.clone()) { if let Some(t) = store.record_file(&c.abs, None) { fresh.push(format!("[{}#{t}]", c.display)); } } }
    let stale = applied.total != p.total || applied.touched != p.files || applied.counts != p.counts;
    let tags = if fresh.is_empty() { String::new() } else { format!("\n{}", fresh.join("\n")) };
    if stale {
        let text = if applied.total == 0 { format!("Preview is stale / no longer matches; no replacements were applied. Preview expected {} in {}.", plural("replacement", p.total), plural("file", p.files)) }
            else if applied.total < p.total { format!("Preview is stale / no longer matches; only {} of {} replacements were applied in {} of {} files.", applied.total, p.total, applied.touched, p.files) }
            else { format!("Preview is stale / no longer matches; applied {} replacements but preview expected {}.", applied.total, p.total) };
        return Ok((format!("{text}{tags}"), true));
    }
    Ok((format!("Applied {} in {}.{tags}", plural("replacement", applied.total), plural("file", applied.touched)), false))
}

pub fn reject(pending: &PendingList, reason: &str) -> String {
    match pending.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
        Some(p) => format!("Discarded: {}. Reason: {reason}", p.label),
        None => "Nothing to reject; no pending action remains.".into(),
    }
}
