//! `lsp diagnostics file="*"`: runs the project's own checker (cargo / tsc / go / pyright), omp `workspace-diagnostics.ts`.
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

struct Checker { description: &'static str, command: Option<Vec<String>> }

fn detect(cwd: &Path) -> Vec<Checker> {
    let has = |n: &str| cwd.join(n).exists();
    let cmd = |a: &[&str]| Some(a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let mut found = Vec::new();
    if has("Cargo.toml") { found.push(Checker { description: "Rust (cargo check)", command: cmd(&["cargo", "check", "--message-format=short"]) }); }
    if has("tsconfig.json") { found.push(Checker { description: "TypeScript (tsc --noEmit)", command: cmd(&["npx", "tsc", "--noEmit"]) }); }
    if has("go.work") { found.push(Checker { description: "Go workspace (go build)", command: cmd(&["go", "build", "./..."]) }); }
    else if has("go.mod") { found.push(Checker { description: "Go (go build)", command: cmd(&["go", "build", "./..."]) }); }
    if has("pyproject.toml") || has("pyrightconfig.json") { found.push(Checker { description: "Python (pyright)", command: cmd(&["pyright"]) }); }
    if found.is_empty() { found.push(Checker { description: "Unknown project type", command: None }); }
    found
}

async fn run_one(cwd: &Path, c: &Checker, limit: Duration) -> String {
    let Some(command) = &c.command else { return "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml)".into() };
    let mut cmd = Command::new(&command[0]);
    cmd.args(&command[1..]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(p) = super::shell_path() { cmd.env("PATH", p); }
    let out = match tokio::time::timeout(limit, cmd.output()).await { Ok(Ok(o)) => o, Ok(Err(e)) => return format!("Failed to run {}: {e}", command.join(" ")), Err(_) => return format!("Failed to run {}: timed out", command.join(" ")) };
    let combined = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if combined.is_empty() {
        return match out.status.code() { Some(0) => "No issues found".into(), Some(c) => format!("Failed to run {}: the checker exited with code {c} without reporting anything, so the workspace was not verified", command.join(" ")), None => format!("Failed to run {}: the checker was killed without reporting anything, so the workspace was not verified", command.join(" ")) };
    }
    let lines: Vec<&str> = combined.split('\n').collect();
    if lines.len() > 50 { format!("{}\n[…{}ln elided…]", lines[..50].join("\n"), lines.len() - 50) } else { combined }
}

pub async fn run(cwd: &Path, limit: Duration) -> (String, String) {
    let checkers = detect(cwd);
    let description = checkers.iter().map(|c| c.description).collect::<Vec<_>>().join(" + ");
    let mut sections = Vec::new();
    for c in &checkers { sections.push((c.description, run_one(cwd, c, limit).await)); }
    let output = if sections.len() == 1 { sections.remove(0).1 } else { sections.iter().map(|(d, o)| format!("=== {d} ===\n{o}")).collect::<Vec<_>>().join("\n\n") };
    (description, output)
}
