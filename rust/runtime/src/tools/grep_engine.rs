//! Per-file content search for `grep`: matcher fallbacks, context lines, column windows (ported from omp's grep.rs).
use std::{fs::File, io::Read, path::Path};

pub const MAX_COLUMNS: usize = 512;
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

pub enum Matcher { Std(regex::Regex), Fancy(fancy_regex::Regex) }

impl Matcher {
    pub fn find(&self, text: &str) -> Option<(usize, usize)> {
        match self {
            Self::Std(r) => r.find(text).map(|m| (m.start(), m.end())),
            Self::Fancy(r) => r.find(text).ok().flatten().map(|m| (m.start(), m.end())),
        }
    }
    fn matches_in<'a>(&'a self, text: &'a str) -> Vec<(usize, usize)> {
        match self {
            Self::Std(r) => r.find_iter(text).map(|m| (m.start(), m.end())).collect(),
            Self::Fancy(r) => r.find_iter(text).flatten().map(|m| (m.start(), m.end())).collect(),
        }
    }
}

/// Escapes `{`/`}` that are not valid `{N}`, `{N,}`, `{N,M}` quantifiers.
fn sanitize_braces(p: &str) -> String {
    let c: Vec<char> = p.chars().collect();
    let (mut out, mut i) = (String::new(), 0);
    while i < c.len() {
        match c[i] {
            '\\' if i + 1 < c.len() => { out.push(c[i]); out.push(c[i + 1]); i += 2; continue; },
            '{' => {
                let end = c[i..].iter().position(|x| *x == '}').map(|n| i + n);
                let valid = end.is_some_and(|e| { let body: String = c[i + 1..e].iter().collect(); !body.is_empty() && body.split(',').count() <= 2 && body.chars().all(|x| x.is_ascii_digit() || x == ',') && !body.starts_with(',') });
                if valid { let e = end.unwrap_or(i); out.extend(&c[i..=e]); i = e + 1; continue; }
                out.push_str("\\{");
            },
            '}' => out.push_str("\\}"),
            x => out.push(x),
        }
        i += 1;
    }
    out
}

fn escape_unescaped_parens(p: &str) -> String {
    let (mut out, mut esc) = (String::new(), false);
    for ch in p.chars() {
        if !esc && (ch == '(' || ch == ')') { out.push('\\'); }
        esc = !esc && ch == '\\';
        out.push(ch);
    }
    out
}

fn try_build(pattern: &str, ignore_case: bool) -> Result<Matcher, String> {
    match regex::RegexBuilder::new(pattern).case_insensitive(ignore_case).build() {
        Ok(r) => Ok(Matcher::Std(r)),
        Err(std_err) => {
            let src = if ignore_case { format!("(?i){pattern}") } else { pattern.to_string() };
            fancy_regex::Regex::new(&src).map(Matcher::Fancy).map_err(|_| std_err.to_string())
        },
    }
}

/// Rust regex, then a look-around capable engine, then unbalanced-paren repair, then literal text.
pub fn build_matcher(pattern: &str, ignore_case: bool) -> Result<Matcher, String> {
    let sanitized = sanitize_braces(pattern);
    match try_build(&sanitized, ignore_case) {
        Ok(m) => Ok(m),
        Err(msg) if msg.contains("unclosed group") || msg.contains("unopened group") || msg.contains("unmatched") => {
            try_build(&escape_unescaped_parens(&sanitized), ignore_case).or_else(|_| try_build(&regex::escape(pattern), ignore_case))
        },
        Err(_) => try_build(&regex::escape(pattern), ignore_case).map_err(|e| format!("Regex error: {e}")),
    }
}

fn truncate_line(line: String, max: usize) -> (String, bool) {
    if line.len() <= max { return (line, false); }
    let cut = line.floor_char_boundary(max.saturating_sub(3));
    (format!("{}...", &line[..cut]), true)
}

/// Fits an over-wide matched line into `max` bytes keeping the first match visible; also returns its 1-indexed column.
fn window_matched_line(line: &str, max: usize, first: Option<(usize, usize)>) -> (String, Option<usize>) {
    let head_end = line.floor_char_boundary(max.saturating_sub(3));
    let Some((start, end)) = first else { return (format!("{}...", &line[..head_end]), None) };
    let start = line.floor_char_boundary(start.min(line.len()));
    let column = Some(line[..start].chars().count() + 1);
    let body = max.saturating_sub(6);
    if end <= head_end || body == 0 { return (format!("{}...", &line[..head_end]), column); }
    let lead = body.saturating_sub(end - start) / 2;
    let from = start.saturating_sub(lead);
    let window = if from + body >= line.len() {
        let from = line.ceil_char_boundary(line.len() - max.saturating_sub(3));
        format!("...{}", &line[from..])
    } else {
        let from = line.ceil_char_boundary(from);
        let to = line.floor_char_boundary(from + body);
        if from == 0 { format!("{}...", &line[..to]) } else { format!("...{}...", &line[from..to]) }
    };
    (window, column)
}

#[derive(Debug, Clone)]
pub struct Found { pub line_number: usize, pub line: String, pub before: Vec<(usize, String)>, pub after: Vec<(usize, String)>, pub truncated: bool, pub column: Option<usize> }

pub struct Params { pub multiline: bool, pub per_file_cap: usize, pub ctx_before: usize, pub ctx_after: usize }

/// Reads up to MAX_FILE_BYTES; text after the first NUL byte is dropped (binary quit).
pub fn read_for_search(path: &Path) -> Option<(String, bool)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() { return None; }
    let oversized = meta.len() > MAX_FILE_BYTES;
    let mut buf = Vec::new();
    File::open(path).ok()?.take(MAX_FILE_BYTES).read_to_end(&mut buf).ok()?;
    if let Some(nul) = buf.iter().position(|b| *b == 0) { buf.truncate(nul); }
    Some((String::from_utf8_lossy(&buf).into_owned(), oversized))
}

/// Returns matches (at most `per_file_cap`) and whether the per-file cap was hit.
pub fn search_text(m: &Matcher, text: &str, p: &Params) -> (Vec<Found>, bool) {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') { lines.pop(); }
    let hits: Vec<(usize, usize)> = if p.multiline {
        let mut starts = Vec::with_capacity(lines.len());
        let mut off = 0;
        for l in &lines { starts.push(off); off += l.len() + 1; }
        let line_of = |pos: usize| starts.partition_point(|s| *s <= pos).saturating_sub(1);
        m.matches_in(text).into_iter().map(|(s, e)| (line_of(s), line_of(e.saturating_sub(1).max(s)))).collect()
    } else {
        lines.iter().enumerate().filter(|(_, l)| m.find(l).is_some()).map(|(i, _)| (i, i)).collect()
    };
    let cap_hit = hits.len() >= p.per_file_cap;
    let hits = &hits[..hits.len().min(p.per_file_cap)];
    let mut out = Vec::new();
    let mut last_emitted: Option<usize> = None;
    for (n, &(first, last)) in hits.iter().enumerate() {
        let before_from = first.saturating_sub(p.ctx_before).max(last_emitted.map_or(0, |e| e + 1));
        let next_start = hits.get(n + 1).map_or(lines.len(), |h| h.0);
        let after_to = (last + p.ctx_after).min(next_start.saturating_sub(1)).min(lines.len().saturating_sub(1));
        let block = lines[first..=last].join("\n");
        let raw = block.trim_end().to_string();
        let (line, truncated, column) = if raw.len() > MAX_COLUMNS {
            let (w, c) = window_matched_line(&raw, MAX_COLUMNS, m.find(&raw));
            (w, true, c)
        } else { (raw, false, None) };
        let ctx = |i: usize| (i + 1, truncate_line(lines[i].trim_end().to_string(), MAX_COLUMNS).0);
        out.push(Found { line_number: first + 1, line, before: (before_from..first).map(ctx).collect(), after: (last + 1..=after_to).filter(|i| *i < lines.len()).map(ctx).collect(), truncated, column });
        last_emitted = Some(after_to.max(last));
    }
    (out, cap_hit)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(pattern: &str, text: &str, ctx: usize) -> Vec<Found> {
        search_text(&build_matcher(pattern, false).unwrap(), text, &Params { multiline: false, per_file_cap: 100, ctx_before: ctx, ctx_after: ctx }).0
    }
    #[test] fn finds_lines_with_context_without_duplicates() {
        let f = run("hit", "a\nhit\nb\nhit\nc\nd\n", 1);
        assert_eq!(f.len(), 2);
        assert_eq!((f[0].line_number, f[0].before.len(), f[0].after.len()), (2, 1, 1));
        assert_eq!((f[1].line_number, f[1].before.len(), f[1].after.len()), (4, 0, 1)); // line 3 already emitted
    }
    #[test] fn invalid_braces_and_groups_fall_back() {
        assert_eq!(run("a{", "a{\nb\n", 0).len(), 1);
        assert_eq!(run("foo(", "foo(\n", 0).len(), 1);
        assert_eq!(run("(?<=x)y", "xy\ny\n", 0).len(), 1); // look-behind via fallback engine
    }
    #[test] fn long_lines_are_windowed_around_the_match() {
        let text = format!("{}NEEDLE{}\n", "a".repeat(2000), "b".repeat(2000));
        let f = &run("NEEDLE", &text, 0)[0];
        assert!(f.truncated && f.line.len() <= MAX_COLUMNS && f.line.contains("NEEDLE"));
        assert_eq!(f.column, Some(2001));
    }
    #[test] fn multiline_matches_report_the_first_line() {
        let m = build_matcher("a\\nb", false).unwrap();
        let (f, _) = search_text(&m, "x\na\nb\ny\n", &Params { multiline: true, per_file_cap: 10, ctx_before: 0, ctx_after: 0 });
        assert_eq!((f[0].line_number, f[0].line.as_str()), (2, "a\nb"));
    }
    #[test] fn per_file_cap_is_reported() {
        let (f, hit) = search_text(&build_matcher("x", false).unwrap(), "x\nx\nx\n", &Params { multiline: false, per_file_cap: 2, ctx_before: 0, ctx_after: 0 });
        assert_eq!((f.len(), hit), (2, true));
    }
}
