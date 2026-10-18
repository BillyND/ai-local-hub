//! Runs one shell command: merged stdout/stderr pipe, process-group kill, timeout and cancellation.
use super::process_group;
use std::{io::Read, path::Path, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::{process::Command, sync::watch, time::timeout};

pub const CAPTURE_CAP: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct Capture { pub bytes: Vec<u8>, pub capped: bool }

pub struct RunResult { pub exit_code: Option<i32>, pub timed_out: bool, pub cancelled: bool, pub wall: Duration, pub spawn_error: Option<String> }

/// omp's `NON_INTERACTIVE_ENV`: no pagers, prompts or colour, quiet package managers.
const NON_INTERACTIVE_ENV: &[(&str, &str)] = &[
    ("PAGER", "cat"), ("GIT_PAGER", "cat"), ("MANPAGER", "cat"), ("SYSTEMD_PAGER", "cat"), ("BAT_PAGER", "cat"), ("DELTA_PAGER", "cat"),
    ("GH_PAGER", "cat"), ("GLAB_PAGER", "cat"), ("PSQL_PAGER", "cat"), ("MYSQL_PAGER", "cat"), ("AWS_PAGER", ""), ("HOMEBREW_PAGER", "cat"),
    ("LESS", "FRX"), ("TERM", "dumb"), ("NO_COLOR", "1"), ("PYTHONUNBUFFERED", "1"), ("GIT_EDITOR", "true"), ("VISUAL", "true"), ("EDITOR", "true"),
    ("GIT_TERMINAL_PROMPT", "0"), ("SSH_ASKPASS", "false"), ("CI", "true"), ("AGENT", "1"), ("npm_config_yes", "true"),
    ("npm_config_update_notifier", "false"), ("npm_config_fund", "false"), ("npm_config_audit", "false"), ("npm_config_progress", "false"),
    ("PNPM_DISABLE_SELF_UPDATE_CHECK", "true"), ("PNPM_UPDATE_NOTIFIER", "false"), ("YARN_ENABLE_TELEMETRY", "0"), ("YARN_ENABLE_PROGRESS_BARS", "0"),
    ("CARGO_TERM_PROGRESS_WHEN", "never"), ("DEBIAN_FRONTEND", "noninteractive"), ("PIP_NO_INPUT", "1"), ("PIP_DISABLE_PIP_VERSION_CHECK", "1"),
    ("TF_INPUT", "0"), ("TF_IN_AUTOMATION", "1"), ("GH_PROMPT_DISABLED", "1"), ("COMPOSER_NO_INTERACTION", "1"), ("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"),
];

fn exit_code(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    { use std::os::unix::process::ExitStatusExt; status.code().or_else(|| status.signal().map(|s| 128 + s)) }
    #[cfg(not(unix))]
    { status.code() }
}

async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        process_group::signal(pid, libc::SIGTERM);
        if timeout(Duration::from_secs(2), child.wait()).await.is_ok() { return; }
        process_group::signal(pid, libc::SIGKILL);
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Resolves when the flag is set or every sender is gone.
async fn cancelled(mut rx: watch::Receiver<bool>) {
    loop {
        if *rx.borrow() { return; }
        if rx.changed().await.is_err() { return; }
    }
}

pub async fn run(command: &str, cwd: &Path, limit: Option<Duration>, capture: Arc<Mutex<Capture>>, cancel: watch::Receiver<bool>) -> RunResult {
    let start = Instant::now();
    let fail = |msg: String| RunResult { exit_code: None, timed_out: false, cancelled: false, wall: start.elapsed(), spawn_error: Some(msg) };
    let (mut reader, writer) = match os_pipe::pipe() { Ok(p) => p, Err(e) => return fail(format!("Could not create output pipe: {e}")) };
    let writer2 = match writer.try_clone() { Ok(w) => w, Err(e) => return fail(format!("Could not create output pipe: {e}")) };
    let mut cmd = if cfg!(windows) { let mut c = Command::new("cmd"); c.args(["/C", command]); c } else { let mut c = Command::new("/bin/bash"); c.args(["-c", command]); c };
    cmd.current_dir(cwd).kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::from(writer)).stderr(Stdio::from(writer2));
    let no_ci = std::env::var_os("PI_BASH_NO_CI").is_some() || std::env::var_os("CLAUDE_BASH_NO_CI").is_some();
    for (k, v) in NON_INTERACTIVE_ENV { if !(no_ci && *k == "CI") { cmd.env(k, v); } }
    if let Some(path) = super::shell_path() { cmd.env("PATH", path); }
    #[cfg(unix)]
    { cmd.process_group(0); }
    let spawned = cmd.spawn();
    drop(cmd); // closes the parent's copies of the pipe writers so the reader sees EOF
    let mut child = match spawned { Ok(c) => c, Err(e) => return fail(format!("Could not spawn shell: {e}")) };
    // Kills the command's whole group if this future is dropped (runtime shutdown) while it still runs.
    let mut group = process_group::Guard::new(child.id());
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    // Weak: a detached grandchild can hold the pipe open long after the result was built. The reader keeps
    // draining (so that writer never hits EPIPE) but stops holding the captured output once nobody needs it.
    let sink = Arc::downgrade(&capture);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Some(sink) = sink.upgrade() else { continue };
                    let mut c = sink.lock().unwrap_or_else(|e| e.into_inner());
                    let room = CAPTURE_CAP.saturating_sub(c.bytes.len());
                    c.bytes.extend_from_slice(&buf[..n.min(room)]);
                    if n > room { c.capped = true; }
                },
            }
        }
        let _ = done_tx.send(());
    });
    let sleeper = async { match limit { Some(d) => tokio::time::sleep(d).await, None => std::future::pending().await } };
    let (mut timed_out, mut was_cancelled, mut code) = (false, false, None);
    tokio::select! {
        status = child.wait() => { code = status.ok().and_then(exit_code); },
        () = sleeper => { timed_out = true; terminate(&mut child).await; },
        () = cancelled(cancel) => { was_cancelled = true; terminate(&mut child).await; },
    }
    // The leader is reaped; anything it deliberately detached keeps running, as it would from a shell.
    group.release();
    // Let the reader drain what the shell wrote, but never wait on a daemonised grandchild holding the pipe.
    let _ = timeout(Duration::from_secs(2), done_rx).await;
    RunResult { exit_code: code, timed_out, cancelled: was_cancelled, wall: start.elapsed(), spawn_error: None }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    async fn go(cmd: &str, secs: Option<u64>) -> (RunResult, String) {
        let cap = Arc::new(Mutex::new(Capture::default()));
        let (_tx, rx) = watch::channel(false);
        let r = run(cmd, Path::new("/tmp"), secs.map(Duration::from_secs), Arc::clone(&cap), rx).await;
        let out = String::from_utf8_lossy(&cap.lock().unwrap().bytes).into_owned();
        (r, out)
    }
    #[tokio::test] async fn merges_stdout_and_stderr_in_order_and_reports_exit_code() {
        let (r, out) = go("echo one; echo two >&2; echo three; exit 7", Some(5)).await;
        assert_eq!((r.exit_code, out.as_str()), (Some(7), "one\ntwo\nthree\n"));
    }
    #[tokio::test] async fn times_out_and_kills_the_group() {
        let (r, _) = go("sleep 30 & sleep 30", Some(1)).await;
        assert!(r.timed_out && r.wall < Duration::from_secs(6));
    }
    #[tokio::test] async fn non_interactive_env_is_set() {
        let (_, out) = go("printf '%s %s' \"$PAGER\" \"$CI\"", Some(5)).await;
        assert_eq!(out, "cat true");
    }
    #[tokio::test] async fn cancellation_stops_the_command() {
        let cap = Arc::new(Mutex::new(Capture::default()));
        let (tx, rx) = watch::channel(false);
        let handle = tokio::spawn(async move { run("sleep 30", Path::new("/tmp"), None, cap, rx).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(true).unwrap();
        let r = handle.await.unwrap();
        assert!(r.cancelled);
    }
}
