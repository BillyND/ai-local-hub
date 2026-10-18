//! Shared plumbing for `ast_grep` / `ast_edit`: candidate files, languages, parse-issue notes.
use super::{grep_scope::Scope, search_paths::format_rel_cwd, search_walk};
use pi_ast::{ops, SupportLang};
use std::{collections::{BTreeSet, HashMap}, path::{Path, PathBuf}};

pub const PARSE_ERRORS_LIMIT: usize = 20;
/// Larger files (bundles, generated code) are skipped and named: one can take seconds and GBs to parse.
pub const MAX_PARSE_BYTES: u64 = 4 * 1024 * 1024;

pub struct Candidate { pub abs: PathBuf, pub display: String }

pub struct Resolved { pub cand: Candidate, pub lang: Option<SupportLang>, pub lang_error: Option<String> }

pub struct Resolution { pub files: Vec<Resolved>, pub languages: HashMap<String, SupportLang>, pub missing: BTreeSet<&'static str> }

/// Files under the scope's targets that ast-grep can parse, de-duplicated and sorted by display path,
/// plus the display paths of supported files skipped for exceeding `MAX_PARSE_BYTES`.
pub fn collect(scope: &Scope, cwd: &Path, lang: Option<&str>) -> Result<(Vec<Candidate>, Vec<String>), String> {
    let mut seen = std::collections::HashSet::new();
    let (mut out, mut oversized) = (Vec::new(), Vec::new());
    for t in &scope.targets {
        let opts = search_walk::Opts { hidden: true, gitignore: true, include_dirs: false, bare_glob: t.bare };
        for e in search_walk::walk(&t.base, t.glob.as_deref(), opts)? {
            if ops::is_supported_file(&e.abs, lang) && seen.insert(e.abs.clone()) {
                let display = format_rel_cwd(&e.abs, cwd, false);
                if e.len > MAX_PARSE_BYTES { oversized.push(display); } else { out.push(Candidate { display, abs: e.abs }); }
            }
        }
    }
    out.sort_by(|a, b| a.display.cmp(&b.display));
    oversized.sort();
    Ok((out, oversized))
}

pub fn oversized_note(skipped: &[String]) -> Option<String> {
    (!skipped.is_empty()).then(|| format!("Skipped {} larger than {} MiB (not parsed): {}", plural("file", skipped.len()), MAX_PARSE_BYTES / (1024 * 1024), skipped.join(", ")))
}

/// Resolves each file's language; languages whose grammar is not bundled are reported as missing.
pub fn resolve(cands: Vec<Candidate>, lang: Option<&str>) -> Resolution {
    let (mut files, mut languages, mut missing) = (Vec::new(), HashMap::new(), BTreeSet::new());
    for cand in cands {
        match ops::resolve_language(lang, &cand.abs) {
            Ok(language) => {
                if !language.wasm_grammar().is_none_or(|g| g.is_installed()) { missing.insert(language.canonical_name()); continue; }
                languages.entry(language.canonical_name().to_string()).or_insert(language);
                files.push(Resolved { cand, lang: Some(language), lang_error: None });
            },
            Err(e) => files.push(Resolved { cand, lang: None, lang_error: Some(e.to_string()) }),
        }
    }
    Resolution { files, languages, missing }
}

pub fn missing_note(missing: &BTreeSet<&'static str>) -> Option<String> {
    (!missing.is_empty()).then(|| format!("Skipped {} files: grammar is not available in this build; results exclude them.", missing.iter().copied().collect::<Vec<_>>().join(", ")))
}

fn dedupe(errors: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    errors.iter().filter(|e| seen.insert((*e).clone())).cloned().collect()
}

/// `Parse issues:` block (capped at 20, with the original total when cut), or no lines.
pub fn format_parse_errors(errors: &[String]) -> Vec<String> {
    let deduped = dedupe(errors);
    if deduped.is_empty() { return Vec::new(); }
    let shown = &deduped[..deduped.len().min(PARSE_ERRORS_LIMIT)];
    let header = if deduped.len() > shown.len() { format!("Parse issues ({} / {}):", shown.len(), deduped.len()) } else { "Parse issues:".to_string() };
    std::iter::once(header).chain(shown.iter().map(|e| format!("- {e}"))).collect()
}

pub fn plural(word: &str, n: usize) -> String { format!("{n} {word}{}", if n == 1 { "" } else { "s" }) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn caps_and_dedupes_parse_issues() {
        let errs: Vec<String> = (0..25).map(|i| format!("f{i}.ts: parse error (syntax tree contains error nodes)")).chain(["f0.ts: parse error (syntax tree contains error nodes)".to_string()]).collect();
        let lines = format_parse_errors(&errs);
        assert_eq!(lines[0], "Parse issues (20 / 25):");
        assert_eq!(lines.len(), 21);
        assert_eq!(format_parse_errors(&["a".into(), "a".into()]), vec!["Parse issues:", "- a"]);
        assert!(format_parse_errors(&[]).is_empty());
    }
    #[test] fn pluralises_counts() { assert_eq!((plural("replacement", 1).as_str(), plural("file", 3).as_str()), ("1 replacement", "3 files")); }
}
