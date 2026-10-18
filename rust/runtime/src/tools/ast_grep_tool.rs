//! omp `ast_grep`: structural search with ast-grep patterns; hashline-tagged `*N:text` output.
use super::{ast_common::{self as common, Resolution}, cancel, grep_scope, search_paths::to_path_list, tree_output};
use ast_grep_core::{tree_sitter::LanguageExt, MatchStrictness};
use pi_ast::ops;
use pi_edit::{path_policy::canonical_key, store::seen_lines_from_body, EditStore};
use std::{collections::HashMap, path::{Path, PathBuf}};

const LIMIT: usize = 50;

pub struct Input { pub pat: String, pub path: Option<String>, pub lang: Option<String>, pub skip: Option<f64> }

struct Hit { display: String, abs: PathBuf, text: String, start_line: usize, meta: HashMap<String, String> }

pub fn run(root: &Path, store: &EditStore, input: Input) -> Result<String, String> {
    let pattern = input.pat.trim().to_string();
    if pattern.is_empty() { return Err("`pat` must be a non-empty pattern".into()); }
    let skip = match input.skip { None => 0, Some(s) if s.is_finite() && s >= 0.0 => s.floor() as usize, _ => return Err("skip must be a non-negative number".into()) };
    let list = to_path_list(input.path.as_deref());
    let scope = grep_scope::resolve(&if list.is_empty() { vec![".".into()] } else { list }, root)?;
    let lang = input.lang.as_deref().map(str::trim).filter(|l| !l.is_empty());
    if let Some(l) = lang { ops::resolve_supported_lang(l).map_err(|e| e.to_string())?; }
    let (cands, oversized) = common::collect(&scope, root, lang)?;
    let Resolution { files, languages, missing } = common::resolve(cands, lang);
    let mut compiled = HashMap::new();
    let mut compile_errors: HashMap<String, String> = HashMap::new();
    for (key, language) in &languages {
        match ops::compile_pattern(&pattern, None, &MatchStrictness::Smart, *language) {
            Ok(p) => { compiled.insert(key.clone(), p); },
            Err(e) => { compile_errors.insert(key.clone(), e.to_string()); },
        }
    }
    // Files come sorted by display path and each file's matches are sorted below, so matches arrive in page
    // order: only the page keeps text, and scanning stops one match past it (enough to know more exist).
    let (mut page, mut parse_errors, mut total) = (Vec::<Hit>::new(), Vec::<String>::new(), 0usize);
    for r in &files {
        if total > skip + LIMIT { break; }
        cancel::check()?;
        if let Some(e) = &r.lang_error { parse_errors.push(format!("{pattern}: {}: {e}", r.cand.display)); continue; }
        let Some(language) = r.lang else { continue };
        let key = language.canonical_name();
        if let Some(e) = compile_errors.get(key) { parse_errors.push(format!("{pattern}: {}: {e}", r.cand.display)); continue; }
        let Some(p) = compiled.get(key) else { continue };
        let source = match std::fs::read_to_string(&r.cand.abs) { Ok(s) => s, Err(e) => { parse_errors.push(format!("{pattern}: {}: {e}", r.cand.display)); continue; } };
        let ast = language.ast_grep(source);
        if ast.root().dfs().any(|n| n.is_error()) { parse_errors.push(format!("{}: parse error (syntax tree contains error nodes)", r.cand.display)); }
        let mut found: Vec<_> = ast.root().find_all(p.clone()).map(|m| {
            let (s, e, range) = (m.start_pos(), m.end_pos(), m.range());
            ((s.line() + 1, s.column(m.get_node()) + 1, e.line() + 1, range.start), m)
        }).collect();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, m) in found {
            if (skip..skip + LIMIT).contains(&total) {
                page.push(Hit { display: r.cand.display.clone(), abs: r.cand.abs.clone(), text: m.text().into_owned(), start_line: key.0, meta: HashMap::<String, String>::from(m.get_env().clone()) });
            }
            total += 1;
        }
    }
    let limit_reached = total > skip + LIMIT;
    let note = [common::missing_note(&missing), common::oversized_note(&oversized)].into_iter().flatten().collect::<Vec<_>>().join("\n");
    let note = (!note.is_empty()).then_some(note);
    let normalized: Vec<String> = parse_errors.iter().map(|e| e.split_once(": ").and_then(|(_, rest)| rest.contains(": parse error (syntax tree").then(|| rest.to_string())).unwrap_or_else(|| e.clone())).collect();
    if page.is_empty() {
        let issues = common::format_parse_errors(&normalized);
        let head = if issues.is_empty() { "No matches found" } else { "No matches found. Parse issues mean the query may be mis-scoped; narrow `path` before concluding absence." };
        let mut out = head.to_string();
        if !issues.is_empty() { out.push_str(&format!("\n{}", issues.join("\n"))); }
        if let Some(n) = note { out.push_str(&format!("\n{n}")); }
        return Ok(out);
    }
    let mut by_file: Vec<(String, PathBuf, Vec<&Hit>)> = Vec::new();
    for h in &page {
        match by_file.iter_mut().find(|f| f.0 == h.display) { Some(f) => f.2.push(h), None => by_file.push((h.display.clone(), h.abs.clone(), vec![h])) }
    }
    let mut sections: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
    for (display, abs, file_hits) in &by_file {
        let tag = store.record_file(abs, None);
        let mut rows: Vec<String> = Vec::new();
        for h in file_hits {
            for (i, line) in h.text.split('\n').enumerate() {
                rows.push(format!("{}{}{}{line}", if i == 0 { '*' } else { ' ' }, h.start_line + i, if tag.is_some() { ':' } else { '|' }));
            }
            if !h.meta.is_empty() {
                let mut kv: Vec<_> = h.meta.iter().collect();
                kv.sort();
                rows.push(format!("  meta: {}", kv.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ")));
            }
        }
        if let Some(t) = &tag { store.record_seen_lines(&canonical_key(abs), t, &seen_lines_from_body(&rows.join("\n"))); }
        sections.insert(display.clone(), (tag, rows));
    }
    let names: Vec<String> = by_file.iter().map(|f| f.0.clone()).collect();
    let mut out: Vec<String> = Vec::new();
    if scope.is_dir {
        let mut emitted = false;
        for ev in tree_output::events(&names.iter().map(|n| (n.clone(), false)).collect::<Vec<_>>()) {
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
        for n in &names {
            let (tag, rows) = &sections[n];
            if !out.is_empty() { out.push(String::new()); }
            if let Some(t) = tag { out.push(format!("[{n}#{t}]")); }
            out.extend(rows.iter().cloned());
        }
    }
    if limit_reached { out.push(String::new()); out.push("Result limit reached; narrow path or increase limit.".into()); }
    let issues = common::format_parse_errors(&normalized);
    if !issues.is_empty() { out.push(String::new()); out.extend(issues); }
    if let Some(n) = note { out.push(String::new()); out.push(n); }
    let (mut text, cut) = super::grep_tool::truncate_head(&out.join("\n"));
    if let Some((kept, total)) = cut { text.push_str(&format!("\n\n[Showing lines 1-{kept} of {total} (50.0KB limit). Narrow `pat` or `path`, or page with `skip`.]")); }
    Ok(text)
}
