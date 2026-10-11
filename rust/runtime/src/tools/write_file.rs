//! omp `write`: whole-file write with hashline-prefix stripping, generated-file guard and snapshot tag.
use super::{display::display_path, hashline_edit::policy};
use pi_edit::{modes::hashline::prefixes::strip_hashline_prefixes, path_policy::{canonical_key, unwrap_hashline_header_path}, text::normalize_to_lf, EditStore};
use std::{fs, path::{Path, PathBuf}};

pub fn run(root: &Path, store: &EditStore, path: &str, content: Option<String>) -> Result<String, String> {
    let content = content.ok_or_else(|| format!("content is required for {path}."))?;
    let path = unwrap_hashline_header_path(path);
    let abs: PathBuf = if Path::new(path).is_absolute() { path.into() } else { root.join(path) };
    let display = display_path(root, &abs);
    if let Ok(meta) = fs::metadata(&abs) {
        if !meta.is_file() {
            return Err(format!("Cannot write '{display}': it is not a regular file."));
        }
        let head = fs::read(&abs).map(|b| b[..b.len().min(1024)].to_vec()).unwrap_or_default();
        if let Some(message) = policy(root).auto_generated_message(&display, &head) { return Err(message); }
    }
    let lines: Vec<String> = content.split('\n').map(String::from).collect();
    let cleaned = strip_hashline_prefixes(&lines).join("\n");
    let stripped = cleaned != content;
    let text = if stripped { cleaned } else { content };
    if text.len() > 32 * 1024 * 1024 { return Err("Write exceeds the 32 MiB limit".into()); }
    if let Some(parent) = abs.parent() { fs::create_dir_all(parent).map_err(|e| format!("Could not write {display}: {e}"))?; }
    fs::write(&abs, &text).map_err(|e| format!("Could not write {display}: {e}"))?;
    let mut notes = String::new();
    #[cfg(unix)]
    if text.starts_with("#!") {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&abs) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            if fs::set_permissions(&abs, perms).is_ok() { notes.push_str("\n[Notice: Made executable via chmod +x]"); }
        }
    }
    let tag = store.record(&canonical_key(&abs), &normalize_to_lf(&text), Some(&[]));
    let mut out = format!("[{display}#{tag}]\nSuccessfully wrote {} bytes to {display}", text.len());
    if stripped { out.push_str("\nNote: auto-stripped hashline display prefixes from content before writing."); }
    out.push_str(&notes);
    Ok(out)
}
