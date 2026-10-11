//! Per-session numbered artifacts (`artifact://N`): the full output behind a truncated tool result.
use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

pub struct Artifacts { dir: PathBuf, next: AtomicU64 }

impl Artifacts {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join("ai-local-hub-artifacts").join(uuid::Uuid::new_v4().to_string());
        Self { dir, next: AtomicU64::new(1) }
    }
    /// Saves `bytes` as the next artifact; returns its id.
    pub fn save(&self, tool: &str, bytes: &[u8]) -> Option<String> {
        fs::create_dir_all(&self.dir).ok()?;
        let id = self.next.fetch_add(1, Ordering::SeqCst).to_string();
        fs::write(self.dir.join(format!("{id}.{tool}.log")), bytes).ok()?;
        Some(id)
    }
    pub fn path_for(&self, id: &str) -> Option<PathBuf> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) { return None; }
        fs::read_dir(&self.dir).ok()?.flatten().map(|e| e.path()).find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&format!("{id}."))))
    }
}

impl Drop for Artifacts {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn saves_numbered_artifacts_and_resolves_them() {
        let a = Artifacts::new();
        assert_eq!(a.save("bash", b"one").as_deref(), Some("1"));
        assert_eq!(a.save("bash", b"two").as_deref(), Some("2"));
        assert_eq!(fs::read(a.path_for("2").unwrap()).unwrap(), b"two");
        assert!(a.path_for("9").is_none() && a.path_for("../x").is_none());
    }
}
