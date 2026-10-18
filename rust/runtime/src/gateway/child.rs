//! One upstream MCP server process: its own process group, piped stdio, stderr pumped into the log.
use crate::mcp_servers::{self, McpServerConfig};
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::{AsyncBufReadExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}};

const MAX_LOG_LINE: usize = 1_000;
const TERM_GRACE: Duration = Duration::from_secs(2);

pub struct Process { child: Child, pid: Option<u32>, finished: bool }

fn resolve_cwd(spec: &McpServerConfig, workspace: &Path) -> Result<PathBuf, String> {
    let Some(raw) = spec.cwd.as_deref() else { return Ok(workspace.to_path_buf()) };
    let path = match raw.strip_prefix("~/") { Some(rest) => dirs::home_dir().unwrap_or_default().join(rest), None if raw == "~" => dirs::home_dir().unwrap_or_default(), None => PathBuf::from(raw) };
    let path = if path.is_absolute() { path } else { workspace.join(path) };
    if path.is_dir() { Ok(path) } else { Err(format!("working directory {} does not exist", path.display())) }
}

/// Windows only starts `.exe` by bare name; `npx`, `uvx` and friends are `.cmd` shims found through PATHEXT.
#[cfg(windows)]
fn program(command: &str, path: Option<&std::ffi::OsStr>) -> PathBuf {
    let given = PathBuf::from(command);
    if given.extension().is_some() || given.components().count() > 1 { return given; }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    for dir in path.map(std::env::split_paths).into_iter().flatten() {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{command}{}", ext.to_ascii_lowercase()));
            if candidate.is_file() { return candidate; }
        }
    }
    given
}
#[cfg(not(windows))]
fn program(command: &str, _path: Option<&std::ffi::OsStr>) -> PathBuf { PathBuf::from(command) }

/// Redacts this server's env secrets before cutting the line, so a cut never exposes part of a secret.
fn pump_stderr(name: String, secrets: Vec<String>, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line).await, Ok(n) if n > 0) {
            let mut text = String::from_utf8_lossy(&line).trim_end().to_string();
            for secret in &secrets { text = text.replace(secret, "[REDACTED]"); }
            if !text.is_empty() {
                let shown: String = text.chars().take(MAX_LOG_LINE).collect();
                super::log(format!("[mcp:{name}] {shown}"));
            }
            line.clear();
        }
    });
}

/// Tells the manager which process groups to kill if this worker dies without cleaning up.
fn report_group(kind: &str, pid: Option<u32>) {
    #[cfg(unix)] if let Some(pid) = pid { println!("{}", serde_json::json!({"type": kind, "pid": pid})); }
    #[cfg(not(unix))] let _ = (kind, pid);
}

pub fn spawn(name: &str, spec: &McpServerConfig, workspace: &Path) -> Result<(Process, ChildStdout, ChildStdin), String> {
    let cwd = resolve_cwd(spec, workspace)?;
    let path = crate::tools::shell_path();
    let mut cmd = Command::new(program(&spec.command, path.as_deref()));
    cmd.args(&spec.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(path) = path { cmd.env("PATH", path); }
    cmd.envs(&spec.env);
    #[cfg(unix)] cmd.process_group(0);
    #[cfg(windows)] cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("cannot start `{}`: {e}", spec.command))?;
    let pid = child.id();
    report_group("child_group", pid);
    // Built before taking the pipes so an early return still kills the group (`Drop`).
    let mut process = Process { child, pid, finished: false };
    let stdout = process.child.stdout.take().ok_or("stdout unavailable")?;
    let stdin = process.child.stdin.take().ok_or("stdin unavailable")?;
    let secrets = mcp_servers::secrets(&std::iter::once((name.to_string(), spec.clone())).collect());
    if let Some(stderr) = process.child.stderr.take() { pump_stderr(name.to_string(), secrets, stderr); }
    Ok((process, stdout, stdin))
}

/// Kills the whole tree of a shim such as `npx.cmd` (Windows has no process groups here).
#[cfg(windows)]
fn kill_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: i32) {
    if let Some(pid) = pid { unsafe { libc::kill(-(pid as i32), signal); } }
}

impl Process {
    /// Resolves when the server process exits; the description is used in logs and errors.
    pub async fn exited(&mut self) -> String {
        match self.child.wait().await { Ok(status) => format!("exited ({status})"), Err(e) => format!("wait failed: {e}") }
    }

    /// TERM the whole group (wrappers such as `npx` leave grandchildren), then KILL what is left.
    pub async fn terminate(&mut self) {
        if self.finished { return; }
        #[cfg(unix)] signal_group(self.pid, libc::SIGTERM);
        #[cfg(windows)] { let pid = self.pid; let _ = tokio::task::spawn_blocking(move || kill_tree(pid)).await; }
        if tokio::time::timeout(TERM_GRACE, self.child.wait()).await.is_err() { let _ = self.child.start_kill(); }
        #[cfg(unix)] signal_group(self.pid, libc::SIGKILL);
        let _ = self.child.wait().await;
        self.finished = true;
        report_group("child_group_exit", self.pid);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // Backstop for paths that never reached `terminate` (task abort, panic).
        if self.finished { return; }
        #[cfg(unix)] signal_group(self.pid, libc::SIGKILL);
        #[cfg(windows)] kill_tree(self.pid);
    }
}
