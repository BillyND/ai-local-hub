//! omp `grep`: scope -> search -> pagination -> grouped hashline output.
use super::{grep_engine::{self as eng, Found, Matcher, Params}, grep_scope::{self, Scope}, search_paths::format_rel_cwd, search_walk, tree_output};
use pi_edit::{path_policy::canonical_key, store::seen_lines_from_body, EditStore};
use std::{collections::HashMap, path::{Path, PathBuf}};

const FILE_WINDOW: usize = 20;
const MULTI_PER_FILE: usize = 20;
const SINGLE_PER_FILE: usize = 200;
const TOTAL_CAP: usize = 2000;
const MAX_OUTPUT_BYTES: usize = 51_200;

pub struct Input { pub pattern: String, pub path: Option<String>, pub case: Option<bool>, pub gitignore: Option<bool>, pub skip: Option<f64> }

struct Hit { abs: PathBuf, found: Found }

fn in_ranges(line: usize, ranges: &[super::read_selector::Range]) -> bool {
    ranges.iter().any(|r| line >= r.start && r.end.is_none_or(|e| line <= e))
}

/// Files searched per batch; the stop flag and the total cap are checked between batches.
const BATCH: usize = 256;

/// Search threads per call: half the cores, at most 4, so one grep never saturates the machine.
fn workers() -> usize {
    static N: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| std::thread::available_parallelism().map_or(1, |n| n.get()).div_ceil(2).clamp(1, 4));
    *N
}

fn search_file(entry: &search_walk::Entry, matcher: &Matcher, params: &Params) -> Option<(Vec<Found>, bool)> {
    let text = eng::read_for_search(&entry.abs, entry.len)?;
    if !matcher.may_match(&text) { return Some((Vec::new(), false)); }
    Some(eng::search_text(matcher, &text, params))
}

/// Searches `batch` on up to `workers()` threads; results keep the batch order.
fn search_batch(batch: &[search_walk::Entry], matcher: &Matcher, params: &Params) -> Vec<Option<(Vec<Found>, bool)>> {
    let threads = workers().min(batch.len() / 16).max(1);
    if threads == 1 { return batch.iter().map(|e| search_file(e, matcher, params)).collect(); }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut out: Vec<Option<(Vec<Found>, bool)>> = (0..batch.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads).map(|_| s.spawn(|| {
            let mut mine = Vec::new();
            loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(entry) = batch.get(i) else { break };
                mine.push((i, search_file(entry, matcher, params)));
            }
            mine
        })).collect();
        for h in handles { for (i, r) in h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)) { out[i] = r; } }
    });
    out
}

fn collect(scope: &Scope, matcher: &Matcher, params: &Params, gitignore: bool) -> Result<(Vec<Hit>, bool, usize), String> {
    let (mut hits, mut limit_reached, mut searched) = (Vec::new(), false, 0usize);
    let mut seen = std::collections::HashSet::new();
    let opts = search_walk::Opts { hidden: true, gitignore, include_dirs: false, bare_glob: false };
    'targets: for t in &scope.targets {
        let files = search_walk::walk(&t.base, t.glob.as_deref(), search_walk::Opts { bare_glob: t.bare, ..opts })?;
        let (small, big): (Vec<_>, Vec<_>) = files.into_iter().partition(|e| e.len <= eng::MAX_FILE_BYTES);
        let ordered: Vec<search_walk::Entry> = small.into_iter().chain(big).collect();
        for batch in ordered.chunks(BATCH) {
            super::cancel::check()?;
            for (entry, result) in batch.iter().zip(search_batch(batch, matcher, params)) {
                let Some((found, cap_hit)) = result else { continue };
                searched += 1;
                limit_reached |= cap_hit;
                for f in found {
                    if !seen.insert((entry.abs.clone(), f.line_number)) { continue; }
                    hits.push(Hit { abs: entry.abs.clone(), found: f });
                    if hits.len() >= TOTAL_CAP { limit_reached = true; break 'targets; }
                }
            }
        }
    }
    Ok((hits, limit_reached, searched))
}

fn render_file(file: &[&Found], tag: bool, truncated_any: &mut bool) -> Vec<String> {
    let (mut out, mut last): (Vec<String>, Option<usize>) = (Vec::new(), None);
    let mut push = |n: usize, text: &str, is_match: bool| {
        if last.is_some_and(|l| n > l + 1) { out.push("...".into()); }
        out.push(if tag { format!("{}{n}:{text}", if is_match { '*' } else { ' ' }) } else { format!("{}{n}|{text}", if is_match { '*' } else { ' ' }) });
        last = Some(n);
    };
    for m in file {
        for (n, l) in &m.before { push(*n, l, false); }
        let text = m.column.map_or(m.line.clone(), |c| format!("{} [col {c}]", m.line));
        push(m.line_number, &text, true);
        if m.truncated { *truncated_any = true; }
        for (n, l) in &m.after { push(*n, l, false); }
    }
    out
}

/// Keeps whole lines up to the byte budget (omp `truncateHead`); returns (text, shown_lines, total_lines).
pub(super) fn truncate_head(text: &str) -> (String, Option<(usize, usize)>) {
    let total = text.split('\n').count();
    if text.len() <= MAX_OUTPUT_BYTES { return (text.to_string(), None); }
    let (mut used, mut kept) = (0usize, 0usize);
    for line in text.split('\n') {
        let add = line.len() + usize::from(kept > 0);
        if used + add > MAX_OUTPUT_BYTES { break; }
        used += add;
        kept += 1;
    }
    (text.split('\n').take(kept).collect::<Vec<_>>().join("\n"), Some((kept, total)))
}

pub fn run(root: &Path, store: &EditStore, input: Input) -> Result<String, String> {
    if input.pattern.trim().is_empty() { return Err("Pattern must not be empty".into()); }
    let skip = match input.skip { None => 0, Some(s) if s.is_finite() && s >= 0.0 => s.floor() as usize, _ => return Err("Skip must be a non-negative number".into()) };
    let list = super::search_paths::to_path_list(input.path.as_deref());
    let scope = grep_scope::resolve(&if list.is_empty() { vec![".".into()] } else { list }, root)?;
    let matcher = eng::build_matcher(&input.pattern, !input.case.unwrap_or(true))?;
    let is_multi = scope.is_dir || scope.exact_files.is_some() || scope.multi;
    let per_file = if is_multi { MULTI_PER_FILE } else { SINGLE_PER_FILE };
    let widen = if scope.ranges.is_empty() { per_file + 1 } else { TOTAL_CAP };
    let params = Params { multiline: input.pattern.contains('\n') || input.pattern.contains("\\n"), per_file_cap: widen, ctx_before: 1, ctx_after: 3 };
    let scope_run = if let Some(files) = &scope.exact_files {
        Scope { targets: files.iter().map(|f| grep_scope::Target { base: f.clone(), glob: None, bare: false }).collect(), ..clone_scope(&scope) }
    } else { clone_scope(&scope) };
    let (mut hits, limit_reached, _searched) = collect(&scope_run, &matcher, &params, input.gitignore.unwrap_or(true))?;
    if !scope.ranges.is_empty() {
        hits = hits.into_iter().filter_map(|mut h| {
            let Some((_, r)) = scope.ranges.iter().find(|(p, _)| *p == super::search_paths::lexical(&h.abs)) else { return Some(h) };
            if !in_ranges(h.found.line_number, r) { return None; }
            h.found.before.retain(|(n, _)| in_ranges(*n, r));
            h.found.after.retain(|(n, _)| in_ranges(*n, r));
            Some(h)
        }).collect();
    }
    // Group by file in encounter order; cap per file for multi-file scopes.
    let mut order: Vec<PathBuf> = Vec::new();
    let mut groups: HashMap<PathBuf, Vec<&Found>> = HashMap::new();
    for h in &hits {
        let e = groups.entry(h.abs.clone()).or_insert_with(|| { order.push(h.abs.clone()); Vec::new() });
        if e.len() >= per_file { continue; }
        e.push(&h.found);
    }
    let total_files = order.len();
    let label = if limit_reached { format!("{total_files}+") } else { total_files.to_string() };
    let skip_files = if is_multi { skip.min(total_files) } else { 0 };
    let window: Vec<&PathBuf> = if is_multi { order.iter().skip(skip_files).take(FILE_WINDOW).collect() } else { order.iter().collect() };
    let file_limit_reached = is_multi && total_files > skip_files + FILE_WINDOW;
    let next_skip = skip_files + window.len();
    let mut notes: Vec<String> = Vec::new();
    if !scope.missing.is_empty() { notes.push(format!("Skipped missing paths: {}", scope.missing.join(", "))); }
    let explicit: Vec<&PathBuf> = if let Some(f) = &scope.exact_files { f.iter().collect() } else if !scope.is_dir && !scope.multi { vec![&scope.search_path] } else { Vec::new() };
    let big: Vec<String> = explicit.iter().filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() > eng::MAX_FILE_BYTES)).map(|p| format_rel_cwd(p, root, false)).collect();
    if !big.is_empty() { notes.push(format!("Searched only the first 4MB of large files (matches past the 4MB window are not shown; use `read` for the rest): {}", big.join(", "))); }
    let warning = notes.join("\n");
    if window.is_empty() {
        let past_end = is_multi && skip > 0 && total_files > 0 && skip_files >= total_files;
        let msg = if past_end { format!("No more results ({label} files total; skip={skip} is past the end)") } else { "No matches found".to_string() };
        return Ok(if warning.is_empty() { msg } else { format!("{msg}\n{warning}") });
    }
    let mut lines_truncated = false;
    let display = |p: &Path| format_rel_cwd(p, root, false);
    let mut sections: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
    let mut files: Vec<String> = Vec::new();
    for abs in &window {
        let key = canonical_key(abs);
        let tag = store.record_file(abs, None);
        let rows = render_file(&groups[*abs], tag.is_some(), &mut lines_truncated);
        if let Some(t) = &tag { store.record_seen_lines(&key, t, &seen_lines_from_body(&rows.join("\n"))); }
        let name = display(abs);
        files.push(name.clone());
        sections.insert(name, (tag, rows));
    }
    let mut out: Vec<String> = Vec::new();
    if scope.is_dir || is_multi {
        let entries: Vec<(String, bool)> = files.iter().map(|f| (f.clone(), false)).collect();
        let mut emitted = false;
        for ev in tree_output::events(&entries) {
            match ev {
                tree_output::Event::Dir { depth, name } => { if emitted { out.push(String::new()); } emitted = true; out.push(format!("{} {name}/", "#".repeat(depth + 1))); },
                tree_output::Event::File { depth, name, key } => {
                    if emitted && depth == 0 { out.push(String::new()); }
                    emitted = true;
                    let (tag, rows) = &sections[&key];
                    out.push(format!("{} {name}{}", "#".repeat(depth + 1), tag.as_ref().map_or(String::new(), |t| format!("#{t}"))));
                    out.extend(rows.iter().cloned());
                },
            }
        }
    } else {
        for name in &files {
            let (tag, rows) = &sections[name];
            if !out.is_empty() { out.push(String::new()); }
            if let Some(t) = tag { out.push(format!("[{name}#{t}]")); }
            out.extend(rows.iter().cloned());
        }
    }
    if file_limit_reached { out.push(String::new()); out.push(format!("Showing files {}-{next_skip} of {label}. Use skip={next_skip} for the next page, or narrow paths/pattern.", skip_files + 1)); }
    if !warning.is_empty() { out.push(String::new()); out.push(warning); }
    let (mut text, cut) = truncate_head(&out.join("\n"));
    let mut parts: Vec<String> = Vec::new();
    if let Some((kept, total)) = cut { parts.push(format!("Showing lines 1-{kept} of {total} ({:.1}KB limit)", MAX_OUTPUT_BYTES as f64 / 1024.0)); }
    if lines_truncated { parts.push(format!("Some lines truncated to {} bytes", eng::MAX_COLUMNS)); }
    if !parts.is_empty() { text.push_str(&format!("\n\n[{}]", parts.join(". "))); }
    Ok(text)
}

fn clone_scope(s: &Scope) -> Scope {
    Scope { search_path: s.search_path.clone(), scope_path: s.scope_path.clone(), is_dir: s.is_dir,
        targets: s.targets.iter().map(|t| grep_scope::Target { base: t.base.clone(), glob: t.glob.clone(), bare: t.bare }).collect(),
        exact_files: s.exact_files.clone(), multi: s.multi, missing: s.missing.clone(), ranges: s.ranges.clone() }
}
