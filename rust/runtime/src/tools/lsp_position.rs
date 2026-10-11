//! Maps `file` + `line` + `symbol` (`name` or `name#N`) to an LSP position (UTF-16 column), omp `resolveSymbolColumn`.
use std::path::Path;

fn is_ident_char(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || c == '$' }

fn bare_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$') && chars.all(is_ident_char)
}

/// Byte offsets of `symbol` in `line`; bare identifiers must sit on word boundaries.
fn find_indexes(line: &str, symbol: &str, ignore_case: bool) -> Vec<usize> {
    if symbol.is_empty() { return Vec::new(); }
    let (hay, needle) = if ignore_case { (line.to_ascii_lowercase(), symbol.to_ascii_lowercase()) } else { (line.to_string(), symbol.to_string()) };
    let boundary = bare_identifier(symbol);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = hay[from..].find(&needle) {
        let at = from + rel;
        let before = hay[..at].chars().next_back();
        let after = hay[at + needle.len()..].chars().next();
        if boundary && (before.is_some_and(is_ident_char) || after.is_some_and(is_ident_char)) { from = at + hay[at..].chars().next().map_or(1, char::len_utf8); continue; }
        out.push(at);
        from = at + needle.len();
    }
    out
}

/// `name#2` -> (`name`, 2); greedy so `#field#2` is private field `#field`, occurrence 2.
fn parse_spec(spec: &str) -> (String, usize) {
    if let Some((name, n)) = spec.rsplit_once('#') {
        if !name.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) { return (name.to_string(), n.parse::<usize>().unwrap_or(1).max(1)); }
    }
    (spec.to_string(), 1)
}

fn utf16_col(line: &str, byte: usize) -> usize { line[..byte].encode_utf16().count() }

pub fn resolve_symbol_column(path: &Path, line: usize, spec: Option<&str>) -> Result<usize, String> {
    let n = line.max(1);
    let text = std::fs::read_to_string(path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { format!("File not found: {}", path.display()) } else { e.to_string() })?;
    let target = text.split('\n').nth(n - 1).unwrap_or("");
    let Some(spec) = spec else { return Ok(target.find(|c: char| !c.is_whitespace()).map_or(0, |b| utf16_col(target, b))) };
    let (symbol, occurrence) = parse_spec(spec);
    let mut hits = find_indexes(target, &symbol, false);
    if hits.is_empty() { hits = find_indexes(target, &symbol, true); }
    if hits.is_empty() { return Err(format!("Symbol \"{symbol}\" not found on line {n}")); }
    if occurrence > hits.len() { return Err(format!("Symbol \"{symbol}\" occurrence {occurrence} is out of bounds on line {n} (found {})", hits.len())); }
    Ok(utf16_col(target, hits[occurrence - 1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn col(text: &str, line: usize, spec: Option<&str>) -> Result<usize, String> {
        let p = std::env::temp_dir().join(format!("lsppos-{}-{}", std::process::id(), text.len()));
        std::fs::write(&p, text).unwrap();
        let r = resolve_symbol_column(&p, line, spec);
        std::fs::remove_file(p).ok();
        r
    }
    #[test] fn finds_symbols_on_word_boundaries_and_by_occurrence() {
        assert_eq!(col("let foo = foobar + foo;\n", 1, Some("foo")), Ok(4));
        assert_eq!(col("let foo = foobar + foo;\n", 1, Some("foo#2")), Ok(19));
        assert_eq!(col("let foo = foobar + foo;\n", 1, Some("foo#3")), Err("Symbol \"foo\" occurrence 3 is out of bounds on line 1 (found 2)".into()));
        assert_eq!(col("x\n", 1, Some("nope")), Err("Symbol \"nope\" not found on line 1".into()));
    }
    #[test] fn defaults_to_first_non_whitespace_and_counts_utf16() {
        assert_eq!(col("    call()\n", 1, None), Ok(4));
        assert_eq!(col("😀 value\n", 1, Some("value")), Ok(3));
    }
    #[test] fn private_fields_and_case_fallback() {
        assert_eq!(col("this.#name = 1; this.#name#\n", 1, Some("#name#2")), Ok(21));
        assert_eq!(col("Hello\n", 1, Some("hello")), Ok(0));
    }
}
