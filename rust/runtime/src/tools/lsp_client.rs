//! One language-server process: JSON-RPC over stdio, document sync, diagnostics and progress tracking (omp `client.ts`).
use super::lsp_config::{detect_language_id, ServerConfig};
use serde_json::{json, Value};
use std::{collections::{hash_map::DefaultHasher, HashMap, HashSet}, hash::{Hash, Hasher}, path::{Path, PathBuf}, process::Stdio, sync::{atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering}, Arc, Mutex}, time::{Duration, Instant}};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, Command}, sync::{oneshot, Mutex as AMutex, Notify}};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const PROJECT_FALLBACK: Duration = Duration::from_secs(15);

pub struct OpenFile { pub version: i64, hash: u64 }
pub struct Published { pub diagnostics: Vec<Value>, pub version: Option<i64>, at: Instant }

pub struct Client {
    pub name: String,
    pub cfg: ServerConfig,
    pub cwd: PathBuf,
    writer: AMutex<ChildStdin>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicI64,
    pub diagnostics: Mutex<HashMap<String, Published>>,
    pub diag_version: AtomicU64,
    pub open_files: Mutex<HashMap<String, OpenFile>>,
    pub capabilities: Mutex<Value>,
    progress: Mutex<HashSet<String>>,
    project_loaded: AtomicBool,
    project_notify: Notify,
    child: AMutex<Option<Child>>,
    started: Instant,
    pub exited: AtomicBool,
    pull_registered: AtomicBool,
    stderr_tail: Mutex<String>,
}

fn hash_text(t: &str) -> u64 { let mut h = DefaultHasher::new(); t.hash(&mut h); h.finish() }

pub fn file_to_uri(p: &Path) -> String {
    let mut out = String::from("file://");
    for b in p.to_string_lossy().bytes() {
        match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' | b'@' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' => out.push(b as char), _ => out.push_str(&format!("%{b:02X}")) }
    }
    out
}

pub fn uri_to_file(uri: &str) -> PathBuf {
    let rest = uri.strip_prefix("file://").unwrap_or(uri);
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() { if let Ok(v) = u8::from_str_radix(&rest[i + 1..i + 3], 16) { out.push(v); i += 3; continue; } }
        out.push(bytes[i]);
        i += 1;
    }
    PathBuf::from(String::from_utf8_lossy(&out).into_owned())
}

fn client_capabilities() -> Value {
    json!({
        "textDocument": {
            "synchronization": {"didSave": true, "dynamicRegistration": false},
            "hover": {"contentFormat": ["markdown", "plaintext"]},
            "definition": {"linkSupport": true}, "typeDefinition": {"linkSupport": true}, "implementation": {"linkSupport": true},
            "references": {}, "documentSymbol": {"hierarchicalDocumentSymbolSupport": true, "symbolKind": {"valueSet": (1..=26).collect::<Vec<_>>()}},
            "rename": {"prepareSupport": true},
            "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"]}}, "isPreferredSupport": true, "disabledSupport": true, "dataSupport": true, "resolveSupport": {"properties": ["edit"]}},
            "publishDiagnostics": {"relatedInformation": true, "versionSupport": true, "tagSupport": {"valueSet": [1, 2]}, "codeDescriptionSupport": true},
            "diagnostic": {"dynamicRegistration": true, "relatedDocumentSupport": false}
        },
        "workspace": {
            "applyEdit": true,
            "workspaceEdit": {"documentChanges": true, "resourceOperations": ["create", "rename", "delete"], "failureHandling": "abort"},
            "configuration": true, "workspaceFolders": true, "symbol": {"symbolKind": {"valueSet": (1..=26).collect::<Vec<_>>()}},
            "fileOperations": {"willRename": true, "didRename": true}
        },
        "window": {"workDoneProgress": true}
    })
}

impl Client {
    pub async fn start(cfg: &ServerConfig, cwd: &Path, timeout: Option<Duration>) -> Result<Arc<Client>, String> {
        let mut cmd = Command::new(&cfg.resolved);
        cmd.args(&cfg.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        { cmd.process_group(0); }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", cfg.command))?;
        let stdin = child.stdin.take().ok_or("language server stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("language server stdout unavailable")?;
        let stderr = child.stderr.take();
        let client = Arc::new(Client {
            name: cfg.command.clone(), cfg: cfg.clone(), cwd: cwd.to_path_buf(), writer: AMutex::new(stdin), pending: Mutex::new(HashMap::new()), next_id: AtomicI64::new(1),
            diagnostics: Mutex::new(HashMap::new()), diag_version: AtomicU64::new(0), open_files: Mutex::new(HashMap::new()), capabilities: Mutex::new(Value::Null),
            progress: Mutex::new(HashSet::new()), project_loaded: AtomicBool::new(false), project_notify: Notify::new(), child: AMutex::new(Some(child)),
            started: Instant::now(), exited: AtomicBool::new(false), pull_registered: AtomicBool::new(false), stderr_tail: Mutex::new(String::new()),
        });
        tokio::spawn(read_loop(Arc::clone(&client), stdout));
        if let Some(err) = stderr {
            let c = Arc::clone(&client);
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await { let mut t = c.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()); t.push_str(&l); t.push('\n'); let n = t.len(); if n > 4000 { *t = t[n - 4000..].to_string(); } }
            });
        }
        let root = file_to_uri(cwd);
        let params = json!({
            "processId": std::process::id(), "rootUri": root, "rootPath": cwd.to_string_lossy(), "capabilities": client_capabilities(),
            "initializationOptions": cfg.init_options.clone().unwrap_or_else(|| json!({})),
            "workspaceFolders": [{"uri": root, "name": cwd.file_name().map_or("workspace".to_string(), |n| n.to_string_lossy().into_owned())}],
        });
        let limit = timeout.or(cfg.warmup_ms.map(Duration::from_millis)).unwrap_or(INIT_TIMEOUT);
        match client.request("initialize", params, Some(limit)).await {
            Ok(result) => {
                *client.capabilities.lock().unwrap_or_else(|e| e.into_inner()) = result.get("capabilities").cloned().unwrap_or(Value::Null);
                client.notify("initialized", json!({})).await;
                client.notify("workspace/didChangeConfiguration", json!({"settings": cfg.settings.clone().unwrap_or_else(|| json!({}))})).await;
                Ok(client)
            },
            Err(e) => { client.kill().await; Err(e) },
        }
    }

    pub fn capability(&self, name: &str) -> Value { self.capabilities.lock().unwrap_or_else(|e| e.into_inner()).get(name).cloned().unwrap_or(Value::Null) }
    pub fn stderr_text(&self) -> String { self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).trim().to_string() }

    async fn write(&self, msg: &Value) {
        let body = msg.to_string();
        let mut w = self.writer.lock().await;
        let _ = w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await;
        let _ = w.write_all(body.as_bytes()).await;
        let _ = w.flush().await;
    }

    pub async fn notify(&self, method: &str, params: Value) { self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params})).await; }

    pub async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, String> {
        if self.exited.load(Ordering::SeqCst) { return Err(format!("LSP server exited: {}", self.stderr_text())); }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await;
        let limit = timeout.unwrap_or(REQUEST_TIMEOUT);
        match tokio::time::timeout(limit, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(format!("LSP server exited: {}", self.stderr_text())),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                self.notify("$/cancelRequest", json!({"id": id})).await;
                Err(format!("LSP request {method} timed out after {}ms", limit.as_millis()))
            },
        }
    }

    pub async fn open_if_needed(&self, path: &Path) {
        let uri = file_to_uri(path);
        if self.open_files.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&uri) { return; }
        let Ok(meta) = std::fs::metadata(path) else { return };
        if !meta.is_file() { return; }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let lang = self.cfg.language_id.clone().unwrap_or_else(|| detect_language_id(path));
        self.open_files.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.clone(), OpenFile { version: 1, hash: hash_text(&text) });
        self.notify("textDocument/didOpen", json!({"textDocument": {"uri": uri, "languageId": lang, "version": 1, "text": text}})).await;
    }

    /// Opens the file, or pushes a full `didChange` when disk content differs from what the server has. True when pushed.
    pub async fn reconcile_from_disk(&self, path: &Path) -> bool {
        let uri = file_to_uri(path);
        let Ok(text) = std::fs::read_to_string(path) else { return false };
        let version = {
            let mut files = self.open_files.lock().unwrap_or_else(|e| e.into_inner());
            match files.get_mut(&uri) {
                None => None,
                Some(f) if f.hash == hash_text(&text) => return false,
                Some(f) => { f.version += 1; f.hash = hash_text(&text); Some(f.version) },
            }
        };
        let Some(version) = version else { self.open_if_needed(path).await; return false };
        self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()).remove(&uri);
        self.notify("textDocument/didChange", json!({"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]})).await;
        true
    }

    /// `didChange` (or `didOpen`) with the current disk text, then `didSave`.
    pub async fn refresh_file(&self, path: &Path) {
        let uri = file_to_uri(path);
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let known = self.open_files.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&uri);
        if !known { self.open_if_needed(path).await; } else {
            let version = { let mut f = self.open_files.lock().unwrap_or_else(|e| e.into_inner()); let o = f.get_mut(&uri).expect("known"); o.version += 1; o.hash = hash_text(&text); o.version };
            self.notify("textDocument/didChange", json!({"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]})).await;
        }
        let include = self.capability("textDocumentSync").get("save").and_then(|s| s.get("includeText")).and_then(Value::as_bool).unwrap_or(false);
        let mut params = json!({"textDocument": {"uri": uri}});
        if include { params["text"] = json!(text); }
        self.notify("textDocument/didSave", params).await;
    }

    pub fn document_version(&self, uri: &str) -> Option<i64> { self.open_files.lock().unwrap_or_else(|e| e.into_inner()).get(uri).map(|f| f.version) }

    /// Waits until the server finished loading the project (progress ended, or the startup fallback elapsed).
    pub async fn wait_project_loaded(&self, max: Duration) {
        let deadline = Instant::now() + max;
        loop {
            let busy = !self.progress.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
            if self.project_loaded.load(Ordering::SeqCst) || (!busy && self.started.elapsed() >= PROJECT_FALLBACK) || self.exited.load(Ordering::SeqCst) { return; }
            if Instant::now() >= deadline { return; }
            let _ = tokio::time::timeout(Duration::from_millis(100), self.project_notify.notified()).await;
        }
    }

    fn supports_pull(&self) -> bool { !self.capability("diagnosticProvider").is_null() || self.pull_registered.load(Ordering::SeqCst) }

    /// Pull model (`textDocument/diagnostic`): a `full` report replaces the cached diagnostics.
    async fn pull_diagnostics(&self, uri: &str, timeout: Duration, version: Option<i64>) -> Result<Option<Vec<Value>>, String> {
        let report = self.request("textDocument/diagnostic", json!({"textDocument": {"uri": uri}}), Some(timeout)).await?;
        if report.get("kind").and_then(Value::as_str) != Some("full") { return Ok(None); }
        let items = report.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.to_string(), Published { diagnostics: items.clone(), version, at: Instant::now() });
        self.diag_version.fetch_add(1, Ordering::SeqCst);
        Ok(Some(items))
    }

    /// Latest diagnostics for `uri` once fresh enough: pulled (when the server supports it), the server echoed
    /// our document version, or the same non-provisional publish has stood unchanged for 250ms (omp `waitForDiagnostics`).
    /// A failed pull is reported only when nothing else arrived, so a broken server is never read as "OK".
    pub async fn wait_for_diagnostics(&self, uri: &str, timeout: Duration, min_version: u64, expected_doc_version: Option<i64>) -> Result<Vec<Value>, String> {
        let deadline = Instant::now() + timeout;
        let mut pull_error = None;
        if self.supports_pull() {
            match self.pull_diagnostics(uri, timeout, expected_doc_version).await { Ok(Some(items)) => return Ok(items), Ok(None) => {}, Err(e) => pull_error = Some(e) }
        }
        loop {
            {
                let d = self.diagnostics.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(p) = d.get(uri).filter(|_| self.diag_version.load(Ordering::SeqCst) > min_version) {
                    if expected_doc_version.is_some() && p.version == expected_doc_version { return Ok(p.diagnostics.clone()); }
                    let provisional = p.diagnostics.is_empty() && p.version.is_none() && expected_doc_version.is_some() && self.started.elapsed() < Duration::from_secs(12);
                    if !provisional && p.at.elapsed() >= Duration::from_millis(250) { return Ok(p.diagnostics.clone()); }
                }
            }
            if Instant::now() >= deadline {
                if let Some(e) = pull_error { return Err(e); }
                return Ok(self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()).get(uri).map(|p| p.diagnostics.clone()).unwrap_or_default());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn kill(&self) {
        self.exited.store(true, Ordering::SeqCst);
        if let Some(mut c) = self.child.lock().await.take() {
            #[cfg(unix)]
            if let Some(pid) = c.id() { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } }
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
    }

    /// `shutdown` then `exit`; kills the process when it does not leave within a second.
    pub async fn shutdown(&self) -> bool {
        let _ = self.request("shutdown", Value::Null, Some(Duration::from_secs(5))).await;
        self.notify("exit", Value::Null).await;
        let mut child = self.child.lock().await;
        let Some(c) = child.as_mut() else { return true };
        let exited = tokio::time::timeout(Duration::from_secs(1), c.wait()).await.is_ok();
        if !exited { drop(child); self.kill().await; }
        self.exited.store(true, Ordering::SeqCst);
        exited
    }
}

async fn read_loop(client: Arc<Client>, stdout: tokio::process::ChildStdout) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut length: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await { Ok(0) | Err(_) => { finish(&client); return; }, Ok(_) => {} }
            let line = line.trim_end();
            if line.is_empty() { break; }
            if let Some(v) = line.strip_prefix("Content-Length:") { length = v.trim().parse().ok(); }
        }
        let Some(len) = length.filter(|l| *l <= 256 * 1024 * 1024) else { continue };
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).await.is_err() { finish(&client); return; }
        let Ok(msg) = serde_json::from_slice::<Value>(&body) else { continue };
        dispatch(&client, msg);
    }
}

fn finish(client: &Arc<Client>) {
    client.exited.store(true, Ordering::SeqCst);
    let pending: Vec<_> = client.pending.lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
    for (_, tx) in pending { let _ = tx.send(Err(format!("LSP server exited: {}", client.stderr_text()))); }
    client.project_notify.notify_waiters();
}

fn dispatch(client: &Arc<Client>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str).map(String::from);
    match (method, msg.get("id").cloned()) {
        (Some(method), Some(id)) => { let c = Arc::clone(client); let params = msg.get("params").cloned().unwrap_or(Value::Null); tokio::spawn(async move { server_request(c, id, method, params).await; }); },
        (Some(method), None) => notification(client, &method, msg.get("params").cloned().unwrap_or(Value::Null)),
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let Some(tx) = client.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) else { return };
            let _ = tx.send(match msg.get("error") {
                Some(e) => Err(format!("LSP error {}: {}", e.get("code").and_then(Value::as_i64).unwrap_or(0), e.get("message").and_then(Value::as_str).unwrap_or(""))),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            });
        },
        _ => {},
    }
}

fn notification(client: &Arc<Client>, method: &str, params: Value) {
    match method {
        "textDocument/publishDiagnostics" => {
            let Some(uri) = params.get("uri").and_then(Value::as_str) else { return };
            let diagnostics = params.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default();
            client.diagnostics.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.to_string(), Published { diagnostics, version: params.get("version").and_then(Value::as_i64), at: Instant::now() });
            client.diag_version.fetch_add(1, Ordering::SeqCst);
        },
        "$/progress" => {
            let token = params.get("token").map(|t| t.to_string()).unwrap_or_default();
            let kind = params.pointer("/value/kind").and_then(Value::as_str).unwrap_or("");
            let mut set = client.progress.lock().unwrap_or_else(|e| e.into_inner());
            if kind == "begin" { set.insert(token); } else if kind == "end" { set.remove(&token); if set.is_empty() { client.project_loaded.store(true, Ordering::SeqCst); } }
            drop(set);
            client.project_notify.notify_waiters();
        },
        _ => {},
    }
}

async fn server_request(client: Arc<Client>, id: Value, method: String, params: Value) {
    let result: Result<Value, (i64, String)> = match method.as_str() {
        "workspace/configuration" => {
            let settings = client.cfg.settings.clone().unwrap_or(Value::Null);
            Ok(Value::Array(params.get("items").and_then(Value::as_array).map(|items| items.iter().map(|i| i.get("section").and_then(Value::as_str).and_then(|s| settings.get(s)).cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default()))
        },
        "workspace/workspaceFolders" => Ok(json!([{"uri": file_to_uri(&client.cwd), "name": client.cwd.file_name().map_or("workspace".to_string(), |n| n.to_string_lossy().into_owned())}])),
        "workspace/applyEdit" => match params.get("edit") {
            Some(edit) => match super::lsp_edits::apply_workspace_edit(edit, &client.cwd) { Ok(_) => Ok(json!({"applied": true})), Err(e) => Ok(json!({"applied": false, "failureReason": e})) },
            None => Ok(json!({"applied": false, "failureReason": "missing edit"})),
        },
        "window/showDocument" => Ok(json!({"success": false})),
        "client/registerCapability" => {
            if params.get("registrations").and_then(Value::as_array).is_some_and(|r| r.iter().any(|x| x.get("method").and_then(Value::as_str) == Some("textDocument/diagnostic"))) { client.pull_registered.store(true, Ordering::SeqCst); }
            Ok(Value::Null)
        },
        "window/workDoneProgress/create" | "client/unregisterCapability" | "window/showMessageRequest" => Ok(Value::Null),
        m if m.ends_with("/refresh") && m.starts_with("workspace/") => Ok(Value::Null),
        m => Err((-32601, format!("Method not found: {m}"))),
    };
    client.write(&match result { Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}), Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}) }).await;
}
