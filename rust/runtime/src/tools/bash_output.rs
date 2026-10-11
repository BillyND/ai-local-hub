//! Shapes raw command output like omp's OutputSink: head + tail with a middle elision, column cap, artifact notices.
const SPILL: usize = 50 * 1024;
const HEAD: usize = 20 * 1024;
const MAX_COLUMNS: usize = 768;

pub fn format_bytes(n: usize) -> String {
    if n < 1024 { format!("{n}B") } else if n < 1024 * 1024 { format!("{:.1}KB", n as f64 / 1024.0) } else { format!("{:.1}MB", n as f64 / 1_048_576.0) }
}

fn with_commas(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() { if i > 0 && (s.len() - i) % 3 == 0 { out.push(','); } out.push(c); }
    out
}

pub struct Shaped { pub body: String, pub needs_artifact: bool, trunc: Option<Trunc>, cut: Option<(usize, usize)> }
struct Trunc { head: usize, tail: usize, total: usize, elided_lines: usize, elided_bytes: usize }

/// CR/CRLF become LF; invalid UTF-8 is replaced.
pub fn normalize(raw: &[u8]) -> String { String::from_utf8_lossy(raw).replace("\r\n", "\n").replace('\r', "\n") }

pub fn shape(raw: &[u8]) -> Shaped {
    let text = normalize(raw);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') { lines.pop(); }
    let total = lines.len();
    let (mut cut_first, mut cut_last) = (None, None);
    let lines: Vec<String> = lines.iter().enumerate().map(|(i, l)| {
        if l.len() <= MAX_COLUMNS { return (*l).to_string(); }
        cut_first.get_or_insert(i + 1);
        cut_last = Some(i + 1);
        format!("{}…", &l[..l.floor_char_boundary(MAX_COLUMNS)])
    }).collect();
    let cut = cut_first.zip(cut_last);
    let joined_len: usize = lines.iter().map(|l| l.len() + 1).sum::<usize>().saturating_sub(1);
    if joined_len <= SPILL { return Shaped { body: lines.join("\n"), needs_artifact: cut.is_some(), trunc: None, cut }; }
    let (mut head, mut used) = (0usize, 0usize);
    while head < total && used + lines[head].len() + usize::from(head > 0) <= HEAD { used += lines[head].len() + usize::from(head > 0); head += 1; }
    let (mut tail, mut tail_used) = (0usize, 0usize);
    while tail < total - head && tail_used + lines[total - 1 - tail].len() + 1 <= SPILL - HEAD { tail_used += lines[total - 1 - tail].len() + 1; tail += 1; }
    let elided_lines = total - head - tail;
    let elided_bytes: usize = lines[head..total - tail].iter().map(|l| l.len() + 1).sum();
    let marker = if elided_lines <= 1 { format!("[…{elided_bytes}B elided…]") } else { format!("[…{elided_lines}ln elided…]") };
    let mut parts: Vec<String> = lines[..head].to_vec();
    parts.push(marker);
    parts.extend_from_slice(&lines[total - tail..]);
    Shaped { body: parts.join("\n"), needs_artifact: true, trunc: Some(Trunc { head, tail, total, elided_lines, elided_bytes }), cut }
}

impl Shaped {
    /// The bracketed notice appended after the result text (omp `formatOutputNotice`).
    pub fn notice(&self, artifact: Option<&str>) -> String {
        let mut parts = Vec::new();
        if let Some(t) = &self.trunc {
            let reference = artifact.map_or(String::new(), |id| format!(". Read artifact://{id} for full output"));
            parts.push(format!("Showing lines 1-{} and {}-{} of {}; {} middle line{} ({}) elided{reference}", t.head, t.total - t.tail + 1, t.total, t.total, with_commas(t.elided_lines), if t.elided_lines == 1 { "" } else { "s" }, format_bytes(t.elided_bytes)));
        }
        if let Some((first, last)) = self.cut {
            let mut note = format!("Some lines truncated to {MAX_COLUMNS} bytes");
            if let Some(id) = artifact {
                note.push_str(&format!(". Use artifact://{id}:raw:{first}-{first} to read line {first} whole"));
                if last > first { note.push_str(&format!("; cut lines run to line {last}, each read the same way")); }
            }
            parts.push(note);
        }
        if parts.is_empty() { String::new() } else { format!("\n\n[{}]", parts.join(". ")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn small_output_is_untouched() {
        let s = shape(b"a\nb\n");
        assert_eq!((s.body.as_str(), s.needs_artifact, s.notice(None).as_str()), ("a\nb", false, ""));
    }
    #[test] fn large_output_keeps_head_and_tail_with_elision_marker() {
        let raw: String = (1..=5000).map(|i| format!("line {i:05}\n")).collect();
        let s = shape(raw.as_bytes());
        assert!(s.body.starts_with("line 00001\n") && s.body.ends_with("line 05000"), "{}", &s.body[s.body.len() - 30..]);
        assert!(s.body.contains("ln elided…]") && s.body.len() < SPILL + 100);
        assert!(s.needs_artifact);
        let n = s.notice(Some("3"));
        assert!(n.starts_with("\n\n[Showing lines 1-") && n.contains("middle lines (") && n.ends_with("Read artifact://3 for full output]"), "{n}");
    }
    #[test] fn long_lines_are_cut_and_named() {
        let raw = format!("ok\n{}\n", "x".repeat(2000));
        let s = shape(raw.as_bytes());
        assert!(s.body.lines().nth(1).unwrap().len() <= MAX_COLUMNS + 3);
        assert_eq!(s.notice(Some("1")), "\n\n[Some lines truncated to 768 bytes. Use artifact://1:raw:2-2 to read line 2 whole]");
    }
    #[test] fn carriage_returns_become_newlines() { assert_eq!(shape(b"a\r\nb\rc").body, "a\nb\nc"); }
    #[test] fn formats_bytes_like_omp() { assert_eq!((format_bytes(512).as_str(), format_bytes(51200).as_str()), ("512B", "50.0KB")); }
}
