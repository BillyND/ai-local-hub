//! How omp shows a path to the model: workspace-relative POSIX, `~/` for home, else absolute.
use std::path::Path;

pub fn display_path(root: &Path, abs: &Path) -> String {
    let shown = if let Ok(rel) = abs.strip_prefix(root) {
        rel.to_string_lossy().into_owned()
    } else if let Some(rel) = dirs::home_dir().and_then(|h| abs.strip_prefix(&h).ok().map(|r| r.to_owned())) {
        format!("~/{}", rel.to_string_lossy())
    } else {
        abs.to_string_lossy().into_owned()
    };
    shown.replace('\\', "/")
}
