//! omp-style `read` for text files: hashline snapshot header, `N:text` rows, windowing and notices.
use super::read_selector::{Range, Selector};
use pi_edit::{path_policy::canonical_key, text::{normalize_to_lf, strip_bom}, EditStore};
use std::path::Path;

pub const DEFAULT_LIMIT: usize = 300;
const MAX_LINES: usize = 3000;
const MAX_BYTES: usize = 51_200;
const MAX_COLUMNS: usize = 768;
const LEADING_CONTEXT: usize = 1;
const TRAILING_CONTEXT: usize = 3;

fn kb(bytes: usize) -> String { format!("{:.1}KB", bytes as f64 / 1024.0) }

/// Cuts one row to the column cap (UTF-16 units, like omp). Returns whether it was cut.
fn cap_columns(line: &str) -> (String, bool) {
    if line.encode_utf16().count() <= MAX_COLUMNS { return (line.to_string(), false); }
    let mut units = 0;
    let mut out = String::new();
    for ch in line.chars() {
        units += ch.len_utf16();
        if units > MAX_COLUMNS { break; }
        out.push(ch);
    }
    out.push('…');
    (out, true)
}

struct Window { start: usize, end: usize }

/// 1-indexed inclusive `start..=end` windows for a selector over `total` lines.
fn windows(sel: &Selector, total: usize) -> Vec<Window> {
    if let Some(n) = sel.tail { return vec![Window { start: total.saturating_sub(n) + 1, end: total }]; }
    if sel.ranges.is_empty() { return vec![Window { start: 1, end: DEFAULT_LIMIT.min(total) }]; }
    let single = sel.ranges.len() == 1 && !sel.raw;
    sel.ranges.iter().map(|Range { start, end }| {
        let mut end = end.unwrap_or(start + DEFAULT_LIMIT - 1).min(total);
        let mut start = *start;
        if single { start = start.saturating_sub(LEADING_CONTEXT).max(1); end = (end + TRAILING_CONTEXT).min(total); }
        Window { start, end }
    }).collect()
}

pub fn render(display: &str, abs: &Path, raw_text: &str, sel: &Selector, store: &EditStore) -> Result<String, String> {
    let (_, without_bom) = strip_bom(raw_text);
    let lf = normalize_to_lf(without_bom).into_owned();
    let mut lines: Vec<&str> = without_bom.split('\n').collect();
    if without_bom.ends_with('\n') { lines.pop(); }
    let total = lines.len();
    if total == 0 { return Ok("The file is empty.".into()); }
    let first_requested = sel.ranges.first().map_or(1, |r| r.start);
    if sel.tail.is_none() && first_requested > total {
        return Err(format!("Line {first_requested} is beyond end of file ({total} lines total). Use :1 to read from the start, or :{total} to read the last line."));
    }
    // omp returns a raw closed range verbatim, with no continuation notice.
    let closed_range = sel.ranges.last().is_some_and(|r| r.end.is_some());
    let mut body: Vec<String> = Vec::new();
    let (mut bytes, mut cut_rows, mut byte_stop) = (0usize, Vec::new(), None);
    let mut shown: Vec<u32> = Vec::new();
    let mut last_shown = 0;
    'outer: for (i, w) in windows(sel, total).into_iter().enumerate() {
        if i > 0 { body.push("…".into()); }
        for n in w.start..=w.end.min(total) {
            if n - w.start >= MAX_LINES { break; }
            let (row, cut) = if sel.raw { (lines[n - 1].to_string(), false) } else { cap_columns(lines[n - 1]) };
            if cut { cut_rows.push(n); }
            let formatted = if sel.raw { row } else { format!("{n}:{row}") };
            if bytes + formatted.len() > MAX_BYTES && !body.is_empty() { byte_stop = Some(n); break 'outer; }
            bytes += formatted.len() + 1;
            body.push(formatted);
            shown.push(n as u32);
            last_shown = n;
        }
    }
    let mut text = body.join("\n");
    let key = canonical_key(abs);
    let tag = store.record(&key, &lf, None);
    store.record_seen_lines(&key, &tag, &shown);
    if !sel.raw { text = format!("[{display}#{tag}]\n{text}"); }
    if let Some(stop) = byte_stop {
        text.push_str(&format!("\n\n[Showing lines {first_requested}-{} of {total} ({} limit). Use {display}:{stop} to continue]", stop - 1, kb(MAX_BYTES)));
    } else if sel.tail.is_none() && last_shown < total && sel.ranges.len() <= 1 && !(sel.raw && closed_range) {
        text.push_str(&format!("\n\n[{} more lines in file. Use {display}:{} to continue]", total - last_shown, last_shown + 1));
    }
    if let (Some(first), Some(last)) = (cut_rows.first(), cut_rows.last()) {
        text.push_str(&format!("\n\n[Some lines truncated to {MAX_COLUMNS} chars. Use {display}:raw:{first}-{first} to read line {first} whole; cut lines run to line {last}, each read the same way]"));
    }
    Ok(text)
}
