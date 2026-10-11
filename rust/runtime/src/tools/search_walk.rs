//! Directory walk with omp's search rules: gitignore, hidden files, `.git`/`node_modules` pruning, glob filter.
use globset::{Glob, GlobBuilder, GlobMatcher};
use ignore::WalkBuilder;
use std::{path::{Path, PathBuf}, time::SystemTime};

pub struct Entry { pub abs: PathBuf, pub rel: String, pub is_dir: bool, pub mtime: SystemTime }

#[derive(Clone, Copy)]
pub struct Opts { pub hidden: bool, pub gitignore: bool, pub include_dirs: bool, pub bare_glob: bool }

/// A bare glob (`*.ts`) recurses; unclosed `{` are auto-closed.
pub fn build_glob(pattern: &str, recursive: bool) -> Result<GlobMatcher, String> {
    let mut p = pattern.replace('\\', "/");
    let missing = p.matches('{').count().saturating_sub(p.matches('}').count());
    p.push_str(&"}".repeat(missing));
    if recursive && !p.contains('/') && !p.starts_with("**") { p = format!("**/{p}"); }
    GlobBuilder::new(&p).literal_separator(true).build().map(|g: Glob| g.compile_matcher()).map_err(|e| format!("Invalid glob: {e}"))
}

pub fn walk(base: &Path, glob: Option<&str>, opts: Opts) -> Result<Vec<Entry>, String> {
    let matcher = glob.map(|g| build_glob(g, opts.bare_glob)).transpose()?;
    let mentions_modules = glob.is_some_and(|g| g.contains("node_modules"));
    let meta = std::fs::metadata(base).map_err(|e| format!("{}: {e}", base.display()))?;
    if meta.is_file() {
        let name = base.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(vec![Entry { abs: base.to_path_buf(), rel: name, is_dir: false, mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) }]);
    }
    let root = base.to_path_buf();
    let mut builder = WalkBuilder::new(base);
    builder.hidden(!opts.hidden).git_ignore(opts.gitignore).git_global(opts.gitignore).git_exclude(opts.gitignore)
        .ignore(opts.gitignore).parents(opts.gitignore).require_git(false).follow_links(false)
        .sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(move |e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(name == ".git" || (name == "node_modules" && !mentions_modules))
        });
    let mut out = Vec::new();
    for item in builder.build().flatten() {
        if item.depth() == 0 { continue; }
        let is_dir = item.file_type().is_some_and(|t| t.is_dir());
        if is_dir && !opts.include_dirs { continue; }
        if !is_dir && !item.file_type().is_some_and(|t| t.is_file()) { continue; }
        let rel = item.path().strip_prefix(&root).unwrap_or(item.path()).to_string_lossy().replace('\\', "/");
        if matcher.as_ref().is_some_and(|m| !m.is_match(&rel)) { continue; }
        let mtime = item.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
        out.push(Entry { abs: item.path().to_path_buf(), rel, is_dir, mtime });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tree() -> PathBuf {
        let d = std::env::temp_dir().join(format!("walk-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        for f in ["a.ts", "src/b.ts", "src/deep/c.ts", "node_modules/x.ts", ".hidden/h.ts", "ignored.ts", ".gitignore"] {
            let p = d.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, if f == ".gitignore" { "ignored.ts\n" } else { "x" }).unwrap();
        }
        d
    }
    fn names(v: Vec<Entry>) -> Vec<String> { v.into_iter().map(|e| e.rel).collect() }
    #[test] fn bare_glob_recurses_and_prefixed_glob_does_not() {
        let d = tree();
        let o = Opts { hidden: true, gitignore: true, include_dirs: false, bare_glob: true };
        assert_eq!(names(walk(&d, Some("*.ts"), o).unwrap()), vec![".hidden/h.ts", "a.ts", "src/b.ts", "src/deep/c.ts"]);
        let o = Opts { bare_glob: false, ..o };
        assert_eq!(names(walk(&d, Some("src/*.ts"), o).unwrap()), vec!["src/b.ts"]);
        let o = Opts { hidden: false, ..o };
        assert!(!names(walk(&d, Some("**/*.ts"), o).unwrap()).iter().any(|n| n.starts_with(".hidden")));
        std::fs::remove_dir_all(d).ok();
    }
    #[test] fn gitignore_can_be_disabled_and_node_modules_needs_mention() {
        let d = tree();
        let o = Opts { hidden: true, gitignore: false, include_dirs: false, bare_glob: true };
        assert!(names(walk(&d, Some("*.ts"), o).unwrap()).contains(&"ignored.ts".to_string()));
        assert!(names(walk(&d, Some("node_modules/*.ts"), Opts { bare_glob: false, ..o }).unwrap()).contains(&"node_modules/x.ts".to_string()));
        assert!(!names(walk(&d, Some("*.ts"), o).unwrap()).iter().any(|n| n.starts_with("node_modules")));
        std::fs::remove_dir_all(d).ok();
    }
}
