//! `read` path selectors (`file:50-80`, `file:-5`, `file:3,9-12`, `file:raw`), ported from omp.
use std::path::Path;

/// One requested line window, 1-indexed. `end == None` means "to the default limit".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range { pub start: usize, pub end: Option<usize> }

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Selector {
    pub raw: bool,
    pub tail: Option<usize>,
    pub ranges: Vec<Range>,
}

fn parse_chunk(chunk: &str) -> Result<Range, String> {
    let chunk = chunk.trim();
    let strip = |s: &str| s.strip_prefix(['L', 'l']).unwrap_or(s).to_string();
    let num = |s: &str| strip(s).parse::<usize>().map_err(|_| format!("Invalid range {chunk}"));
    let (start, end) = if let Some((a, b)) = chunk.split_once("..") {
        (num(a)?, if b.is_empty() { None } else { Some(num(b)?) })
    } else if let Some((a, b)) = chunk.split_once('+') {
        let (start, count) = (num(a)?, num(b)?);
        if count < 1 { return Err(format!("Invalid range {chunk}: count must be >= 1.")); }
        (start, Some(start + count - 1))
    } else if let Some((a, b)) = chunk.split_once('-') {
        (num(a)?, if b.is_empty() { None } else { Some(num(b)?) })
    } else {
        (num(chunk)?, None)
    };
    if start == 0 { return Err("Line selector 0 is invalid; lines are 1-indexed. Use :1.".into()); }
    if end.is_some_and(|e| e < start) { return Err(format!("Invalid range {chunk}: end must be >= start.")); }
    Ok(Range { start, end })
}

fn looks_like_range_list(sel: &str) -> bool {
    let body = sel.strip_prefix('-').unwrap_or(sel);
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '-' | '+' | '.' | 'L' | 'l'))
        && body.chars().next().is_some_and(|c| c.is_ascii_digit() || matches!(c, 'L' | 'l'))
}

/// Parses the text after a path's last colon(s). `Ok(None)` means "not a selector".
pub fn parse(sel: &str) -> Result<Option<Selector>, String> {
    let mut out = Selector::default();
    let mut seen_range = false;
    for part in sel.split(':') {
        let lower = part.to_ascii_lowercase();
        if lower == "raw" { out.raw = true; continue; }
        if seen_range || !looks_like_range_list(&lower) { return Ok(None); }
        seen_range = true;
        if let Some(n) = lower.strip_prefix('-') {
            let n: usize = n.parse().map_err(|_| "Invalid tail selector".to_string())?;
            if n == 0 { return Err("Tail selector -0 is invalid; use :-N with N >= 1 to read the last N lines.".into()); }
            out.tail = Some(n);
        } else {
            for chunk in lower.split(',') { out.ranges.push(parse_chunk(chunk)?); }
            out.ranges.sort_by_key(|r| r.start);
        }
    }
    Ok(Some(out))
}

/// Splits `path:selector`. A literal file named like a selector wins.
pub fn split(input: &str, resolve: impl Fn(&str) -> std::path::PathBuf) -> Result<(String, Selector), String> {
    if Path::new(&resolve(input)).symlink_metadata().is_ok() { return Ok((input.to_string(), Selector::default())); }
    let colons: Vec<usize> = input.match_indices(':').map(|(i, _)| i).collect();
    // Try the earlier of the last two colons first (`file:raw:2-4`), then the last one.
    let mut candidates = Vec::new();
    if colons.len() >= 2 { candidates.push(colons[colons.len() - 2]); }
    if let Some(&last) = colons.last() { candidates.push(last); }
    for at in candidates {
        let (path, sel) = (&input[..at], &input[at + 1..]);
        if path.is_empty() { continue; }
        if let Some(parsed) = parse(sel)? { return Ok((path.to_string(), parsed)); }
    }
    Ok((input.to_string(), Selector::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_ranges_tail_and_raw() {
        assert_eq!(parse("50-80").unwrap().unwrap().ranges, vec![Range { start: 50, end: Some(80) }]);
        assert_eq!(parse("50+3").unwrap().unwrap().ranges[0].end, Some(52));
        assert_eq!(parse("5-16,960-973").unwrap().unwrap().ranges.len(), 2);
        assert_eq!(parse("-5").unwrap().unwrap().tail, Some(5));
        let s = parse("raw:2-4").unwrap().unwrap();
        assert!(s.raw && s.ranges[0].start == 2);
        assert!(parse("notes").unwrap().is_none());
        assert!(parse("0").is_err());
        assert!(parse("-0").is_err());
    }
    #[test] fn literal_file_wins_over_selector() {
        let dir = std::env::temp_dir().join(format!("sel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a:1-2"), "x").unwrap();
        let d = dir.clone();
        let (p, s) = split("a:1-2", |x| d.join(x)).unwrap();
        assert_eq!(p, "a:1-2");
        assert!(s.ranges.is_empty());
        let (p, s) = split("b.rs:3-4", |x| dir.join(x)).unwrap();
        assert_eq!((p.as_str(), s.ranges.len()), ("b.rs", 1));
        std::fs::remove_dir_all(dir).ok();
    }
}
