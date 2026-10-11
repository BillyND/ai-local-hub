//! Directory view for `read`: one `- name` row per entry, newest first, capped like omp's per-directory limit.
use std::{fs, path::Path, time::SystemTime};

const CHILD_LIMIT: usize = 12;

pub fn list(dir: &Path) -> String {
    let Ok(entries) = fs::read_dir(dir) else { return "(empty directory)".into() };
    let mut rows: Vec<(String, SystemTime)> = entries.flatten().map(|e| {
        let is_dir = e.path().is_dir();
        let name = e.file_name().to_string_lossy().into_owned();
        let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        (if is_dir { format!("{name}/") } else { name }, modified)
    }).collect();
    if rows.is_empty() { return "(empty directory)".into(); }
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let total = rows.len();
    let mut lines: Vec<String> = rows.into_iter().map(|r| format!("- {}", r.0)).collect();
    if total > CHILD_LIMIT {
        let last = lines.pop().unwrap_or_default();
        lines.truncate(CHILD_LIMIT - 2);
        lines.push(format!("- … {} more", total - (CHILD_LIMIT - 1)));
        lines.push(last);
    }
    lines.join("\n")
}
