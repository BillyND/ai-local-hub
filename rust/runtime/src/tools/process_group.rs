//! Child process groups (shell commands, language servers, project checkers) whose leader is still running.
//! Signalling the group reaches grandchildren that killing the leader alone would orphan: on timeout,
//! when the owning future is dropped, and when the runtime shuts down.
use std::{collections::HashSet, sync::{LazyLock, Mutex, MutexGuard}, time::{Duration, Instant}};

static LIVE: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(Default::default);

fn live() -> MutexGuard<'static, HashSet<u32>> { LIVE.lock().unwrap_or_else(|e| e.into_inner()) }

#[cfg(unix)]
pub fn signal(pid: u32, sig: i32) { unsafe { libc::kill(-(pid as i32), sig); } }

#[cfg(unix)]
fn exists(pid: u32) -> bool { unsafe { libc::kill(-(pid as i32), 0) == 0 } }

/// Tracks a group led by a child spawned with `process_group(0)`. Dropping it while armed kills the
/// whole group; call `release` once the leader has been reaped, after which the id may be reused.
pub struct Guard(Option<u32>);

impl Guard {
    pub fn new(pid: Option<u32>) -> Self {
        let pid = pid.filter(|_| cfg!(unix));
        if let Some(p) = pid { live().insert(p); }
        Self(pid)
    }
    pub fn release(&mut self) {
        if let Some(p) = self.0.take() { live().remove(&p); }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            #[cfg(unix)]
            signal(p, libc::SIGKILL);
            live().remove(&p);
        }
    }
}

/// SIGTERM to every tracked group, then SIGKILL to whatever is still there after `grace`.
pub async fn stop_all(grace: Duration) {
    #[cfg(unix)]
    {
        let groups: Vec<u32> = live().iter().copied().collect();
        if groups.is_empty() { return; }
        for g in &groups { if live().contains(g) { signal(*g, libc::SIGTERM); } }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline && groups.iter().any(|g| exists(*g)) { tokio::time::sleep(Duration::from_millis(50)).await; }
        // Only groups still tracked here and above: a released id belongs to a reaped leader and may have
        // been reused.
        for g in groups { if live().contains(&g) && exists(g) { signal(g, libc::SIGKILL); } }
    }
    #[cfg(not(unix))]
    let _ = (grace, Instant::now());
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::os::unix::process::CommandExt;
    #[test] fn dropping_an_armed_guard_kills_the_whole_group() {
        let mut leader = Command::new("/bin/sh").args(["-c", "sleep 30 & echo $!; wait"]).process_group(0).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(leader.stdout.take().unwrap()), &mut line).unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        drop(Guard::new(Some(leader.id())));
        leader.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(grandchild, 0) } == 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        assert_ne!(unsafe { libc::kill(grandchild, 0) }, 0, "grandchild survived");
    }
    #[test] fn released_guards_leave_the_group_alone() {
        let mut child = Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
        let mut g = Guard::new(Some(child.id()));
        g.release();
        drop(g);
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
