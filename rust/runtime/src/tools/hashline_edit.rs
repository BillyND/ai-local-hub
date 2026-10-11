//! omp hashline `edit`: runs the vendored `pi-edit` engine and persists through a disk writer.
use async_trait::async_trait;
use pi_edit::{
    session::SessionConfig, ApplyRequest, EditError, EditMode, EditResult, EditStore, EditWriter, FileOp,
    PathPolicy, Session, WriteRequest, WriteResponse,
};
use std::{fs, path::{Path, PathBuf}};

struct DiskWriter;

fn io(error: impl std::fmt::Display) -> EditError { EditError::Writer(error.to_string()) }

/// Writes next to the target and renames, so an I/O error never truncates the original.
pub fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let tmp = target.with_extension(format!("ailocalhub-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        if let Ok(meta) = fs::metadata(&target) { file.set_permissions(meta.permissions())?; }
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}

#[async_trait]
impl EditWriter for DiskWriter {
    async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
        let written = match request.op {
            FileOp::Delete => { fs::remove_file(&request.absolute).map_err(io)?; String::new() },
            FileOp::Noop => String::new(),
            FileOp::Create | FileOp::Update => {
                let content = request.content.clone().unwrap_or_default();
                let target = request.move_to.clone().unwrap_or_else(|| request.absolute.clone());
                write_atomic(&target, &content).map_err(io)?;
                if request.move_to.is_some() { let _ = fs::remove_file(&request.absolute); }
                content
            },
        };
        Ok(WriteResponse { written, diagnostics_json: None })
    }
}

pub fn policy(root: &Path) -> PathPolicy {
    PathPolicy {
        cwd: root.to_path_buf(),
        home_dir: dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
        url_schemes: Vec::new(),
        url_alias_schemes: Vec::new(),
        plan_writable_roots: Vec::new(),
        plan_active: false,
        block_auto_generated: true,
    }
}

/// Applies one hashline patch. `Err` carries the engine's model-facing message verbatim.
pub async fn apply(root: &Path, store: &EditStore, input: &str) -> Result<String, String> {
    let config = SessionConfig {
        mode: EditMode::Hashline, policy: policy(root), allow_fuzzy: true, fuzzy_threshold: 0.95,
        enforce_seen_lines: true, raw_input: false,
    };
    let mut session = Session::new(config, store.clone());
    session.set_args_json(&serde_json::json!({ "input": input }).to_string());
    session.finish();
    session.apply(ApplyRequest::default(), &DiskWriter).await.map(|outcome| outcome.text).map_err(|e| e.to_string())
}
