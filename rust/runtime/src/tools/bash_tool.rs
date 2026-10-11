//! omp `bash`: leading-`cd` lift, timeout clamp, foreground run with auto-background, result text.
use super::{artifacts::Artifacts, bash_jobs::Jobs, bash_output, bash_run::{self, Capture, RunResult}, search_paths::resolve_to_cwd};
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio::sync::{watch, OwnedSemaphorePermit};

const DEFAULT_TIMEOUT: f64 = 300.0;
const MIN_TIMEOUT: f64 = 1.0;
const MAX_TIMEOUT: f64 = 3600.0;
/// omp's `bash.autoBackground.thresholdMs` (60s); `AI_LOCAL_HUB_AUTO_BG_SECS` overrides it, `off` disables it.
fn auto_background_secs() -> Option<f64> {
    match std::env::var("AI_LOCAL_HUB_AUTO_BG_SECS") {
        Ok(v) if v.eq_ignore_ascii_case("off") => None,
        Ok(v) => Some(v.parse().unwrap_or(60.0)),
        Err(_) => Some(60.0),
    }
}

pub struct Input { pub command: String, pub timeout: Option<f64>, pub cwd: Option<String>, pub pty: Option<bool>, pub background: Option<bool> }
pub struct Ctx { pub root: std::path::PathBuf, pub artifacts: Arc<Artifacts>, pub jobs: Arc<Jobs>, pub permit: OwnedSemaphorePermit }

fn num(n: f64) -> String { if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() } }

/// `cd <path> && rest` becomes `cwd=<path>` + `rest` when the path needs no shell expansion.
pub fn extract_leading_cd(command: &str) -> Option<(String, String)> {
    let rest = command.strip_prefix("cd")?;
    let trimmed = rest.trim_start_matches([' ', '\t']);
    if trimmed.len() == rest.len() { return None; }
    let chars: Vec<char> = trimmed.chars().collect();
    let (mut i, mut path, mut single, mut double) = (0, String::new(), false, false);
    while i < chars.len() {
        let ch = chars[i];
        if single { if ch == '\'' { single = false; } else { path.push(ch); } }
        else if double {
            if ch == '\\' && i + 1 < chars.len() {
                let next = chars[i + 1];
                if next == '\n' || next == '\r' { return None; }
                if matches!(next, '"' | '\\' | '$' | '`') { path.push(next); i += 2; continue; }
            }
            if ch == '"' { double = false; } else { path.push(ch); }
        } else if ch == '\'' { single = true; }
        else if ch == '"' { double = true; }
        else if ch == '\\' && i + 1 < chars.len() {
            if chars[i + 1] == '\n' || chars[i + 1] == '\r' { return None; }
            path.push(chars[i + 1]); i += 2; continue;
        } else if matches!(ch, ' ' | '\t' | '\n' | '\r' | '&' | '|' | ';' | '<' | '>' | '(' | ')') { break; }
        else { path.push(ch); }
        i += 1;
    }
    if single || double || path.is_empty() || path.contains(['$', '`', '(']) { return None; }
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') { i += 1; }
    if chars.get(i) != Some(&'&') || chars.get(i + 1) != Some(&'&') { return None; }
    i += 2;
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') { i += 1; }
    Some((path, chars[i..].iter().collect()))
}

struct Built { text: String, failed: bool }

fn build(result: &RunResult, cap: &Capture, timeout_sec: Option<f64>, notices: &[String], artifacts: &Artifacts) -> Built {
    if let Some(e) = &result.spawn_error { return Built { text: e.clone(), failed: true }; }
    let shaped = bash_output::shape(&cap.bytes);
    let artifact = if shaped.needs_artifact { artifacts.save("bash", &cap.bytes) } else { None };
    let mut body = shaped.body.clone();
    let timeout_msg = timeout_sec.map_or("Command timed out".to_string(), |t| format!("Command timed out after {} seconds", num(t)));
    if result.timed_out { body = format!("[{timeout_msg}]\n{body}"); }
    else if result.cancelled { body = format!("[Command cancelled]\n{body}"); }
    let failed_exit = result.exit_code.is_some_and(|c| c != 0);
    let mut lines = vec![if body.is_empty() { "(no output)".to_string() } else { body }];
    let mut all = vec![format!("Wall time: {:.2} seconds", result.wall.as_secs_f64())];
    all.extend(notices.iter().filter(|n| !n.is_empty()).cloned());
    lines.push(String::new());
    lines.extend(all);
    if failed_exit { lines.push(String::new()); lines.push(format!("Command exited with code {}", result.exit_code.unwrap_or(0))); }
    let mut text = lines.join("\n");
    if result.exit_code.is_none() && !result.timed_out && !result.cancelled { text = format!("{}\n\nCommand failed: missing exit status", lines[0]); }
    text.push_str(&shaped.notice(artifact.as_deref()));
    Built { text, failed: failed_exit || result.timed_out || result.cancelled || result.exit_code.is_none() }
}

fn background_notice(id: &str, timeout_sec: Option<f64>) -> String {
    let deadline = timeout_sec.map_or(" (no deadline)".to_string(), |t| format!(" (killed once it has run {}s in total; `timeout: 0` disables the deadline)", num(t)));
    format!("Backgrounded as job {id}{deadline}; its result is appended to your next tool result the moment it finishes, or call `wait`. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work.")
}

struct CancelGuard(Option<watch::Sender<bool>>);
impl Drop for CancelGuard { fn drop(&mut self) { if let Some(tx) = &self.0 { let _ = tx.send(true); } } }

/// Returns (result text, is_error).
pub async fn run(ctx: Ctx, input: Input) -> (String, bool) {
    let Ctx { root, artifacts, jobs, permit } = ctx;
    if input.command.trim().is_empty() { return ("command is required".into(), true); }
    let mut command = input.command.clone();
    let mut cwd_arg = input.cwd.clone().filter(|c| !c.trim().is_empty());
    if cwd_arg.is_none() { if let Some((path, rest)) = extract_leading_cd(&command) { cwd_arg = Some(path); command = rest; } }
    let cwd = match &cwd_arg {
        Some(p) => {
            let abs = resolve_to_cwd(p, &root);
            match std::fs::metadata(&abs) {
                Err(_) => return (format!("Working directory does not exist: {}", abs.display()), true),
                Ok(m) if !m.is_dir() => return (format!("Working directory is not a directory: {}", abs.display()), true),
                Ok(_) => abs,
            }
        },
        None => root.clone(),
    };
    let requested = input.timeout.unwrap_or(DEFAULT_TIMEOUT);
    let timeout_sec = if requested == 0.0 { None } else { Some(requested.clamp(MIN_TIMEOUT, MAX_TIMEOUT)) };
    let mut notices: Vec<String> = Vec::new();
    if let Some(eff) = timeout_sec { if eff != requested { notices.push(format!("Timeout clamped to {}s (requested {}s; allowed range 1-3600s).", num(eff), num(requested))); } }
    if input.pty == Some(true) { notices.push("pty requested but unavailable in this environment; ran without a terminal".into()); }
    let limit = timeout_sec.map(Duration::from_secs_f64);
    let capture = Arc::new(Mutex::new(Capture::default()));
    let (tx, rx) = watch::channel(false);
    let (cap2, root_cmd) = (Arc::clone(&capture), command.clone());
    let task = tokio::spawn(async move { let _permit = permit; bash_run::run(&root_cmd, &cwd, limit, cap2, rx).await });
    let finish = |result: RunResult, capture: &Arc<Mutex<Capture>>, notices: &[String]| {
        let cap = capture.lock().unwrap_or_else(|e| e.into_inner());
        build(&result, &cap, timeout_sec, notices, &artifacts)
    };
    let spawn_job = |task: tokio::task::JoinHandle<RunResult>, tx: watch::Sender<bool>, preview: String, notices: Vec<String>| -> (String, bool) {
        let id = match jobs.register(&command, tx) { Ok(id) => id, Err(e) => return (e, true) };
        let (jobs2, artifacts2, cap3, id2, notices2) = (Arc::clone(&jobs), Arc::clone(&artifacts), Arc::clone(&capture), id.clone(), notices.clone());
        tokio::spawn(async move {
            if let Ok(result) = task.await {
                let built = { let cap = cap3.lock().unwrap_or_else(|e| e.into_inner()); build(&result, &cap, timeout_sec, &notices2, &artifacts2) };
                jobs2.settle(&id2, built.failed, built.text);
            }
        });
        let mut lines: Vec<String> = Vec::new();
        if !preview.trim().is_empty() { lines.push(preview.trim_end().to_string()); lines.push(String::new()); }
        if !notices.is_empty() { lines.extend(notices); lines.push(String::new()); }
        lines.push(background_notice(&id, timeout_sec));
        (lines.join("\n"), false)
    };
    if input.background == Some(true) { return spawn_job(task, tx, String::new(), notices); }
    // Foreground: wait up to the auto-background threshold, then hand the running command to a job.
    let wait_secs = auto_background_secs().map(|threshold| timeout_sec.map_or(threshold, |t| threshold.min((t - 1.0).max(0.0))));
    let mut task = task;
    let mut guard = CancelGuard(Some(tx.clone()));
    tokio::select! {
        res = &mut task => { guard.0 = None; match res { Ok(r) => { let b = finish(r, &capture, &notices); (b.text, b.failed) }, Err(e) => (format!("Command failed: {e}"), true) } },
        () = async { match wait_secs { Some(w) => tokio::time::sleep(Duration::from_secs_f64(w)).await, None => std::future::pending().await } }, if !jobs.at_capacity() => {
            guard.0 = None;
            // With a zero wait window (a timeout clamped to 1s), the child may
            // already have emitted partial output while the timeout branch wins.
            // Omit that racy preview; the settled result delivered by `wait`
            // remains authoritative and keeps the initial response stable.
            let preview = if wait_secs == Some(0.0) { String::new() } else {
                bash_output::shape(&capture.lock().unwrap_or_else(|e| e.into_inner()).bytes).body
            };
            spawn_job(task, tx, preview, notices)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn lifts_a_leading_cd() {
        assert_eq!(extract_leading_cd("cd src && ls"), Some(("src".into(), "ls".into())));
        assert_eq!(extract_leading_cd("cd \"my dir\" && make"), Some(("my dir".into(), "make".into())));
        assert_eq!(extract_leading_cd("cd 'a b'&&echo hi"), Some(("a b".into(), "echo hi".into())));
    }
    #[test] fn leaves_complex_cd_alone() {
        for c in ["cd $HOME && ls", "cd a; ls", "cd a || ls", "cd a && ", "cd", "cdx a && b", "cd \"a && b", "cd a > f && b", "cd `pwd` && b"] {
            if c == "cd a && " { assert_eq!(extract_leading_cd(c), Some(("a".into(), String::new()))); } else { assert_eq!(extract_leading_cd(c), None, "{c}"); }
        }
    }
    #[test] fn builds_text_like_omp() {
        let cap = Capture { bytes: b"hello\n".to_vec(), capped: false };
        let ok = RunResult { exit_code: Some(0), timed_out: false, cancelled: false, wall: Duration::from_millis(1234), spawn_error: None };
        let a = Artifacts::new();
        let b = build(&ok, &cap, Some(300.0), &[], &a);
        assert_eq!((b.text.as_str(), b.failed), ("hello\n\nWall time: 1.23 seconds", false));
        let bad = RunResult { exit_code: Some(7), ..ok };
        let b = build(&bad, &cap, Some(300.0), &["note".into()], &a);
        assert_eq!(b.text, "hello\n\nWall time: 1.23 seconds\nnote\n\nCommand exited with code 7");
        assert!(b.failed);
        let empty = build(&RunResult { exit_code: Some(0), timed_out: false, cancelled: false, wall: Duration::ZERO, spawn_error: None }, &Capture::default(), None, &[], &a);
        assert_eq!(empty.text, "(no output)\n\nWall time: 0.00 seconds");
        let t = build(&RunResult { exit_code: None, timed_out: true, cancelled: false, wall: Duration::from_secs(5), spawn_error: None }, &cap, Some(5.0), &[], &a);
        assert!(t.text.starts_with("[Command timed out after 5 seconds]\nhello\n"), "{}", t.text);
        assert!(t.failed);
    }
}
