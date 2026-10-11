//! Background job registry (`bg_N`): results are delivered with the next tool result or fetched by `wait`.
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::{watch, Notify};

const MAX_RUNNING: usize = 100;
const NOTICE_INLINE_CHARS: usize = 12_000;
const NOTICE_HEAD_CHARS: usize = 4_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum State { Running, Completed, Failed, Cancelled }
impl State { fn word(self) -> &'static str { match self { Self::Running => "running", Self::Completed => "completed", Self::Failed => "failed", Self::Cancelled => "cancelled" } } }

struct Job { label: String, state: State, text: Option<String>, consumed: bool, delivered: bool, cancel: watch::Sender<bool> }

#[derive(Default)]
struct Inner { next: u64, jobs: HashMap<String, Job>, order: Vec<String> }

#[derive(Default)]
pub struct Jobs { inner: Mutex<Inner>, notify: Notify }

fn collapse(label: &str) -> String { label.split_whitespace().collect::<Vec<_>>().join(" ") }

impl Jobs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|e| e.into_inner()) }
    pub fn running(&self) -> usize { self.lock().jobs.values().filter(|j| j.state == State::Running).count() }
    pub fn at_capacity(&self) -> bool { self.running() >= MAX_RUNNING }

    pub fn register(&self, label: &str, cancel: watch::Sender<bool>) -> Result<String, String> {
        let mut g = self.lock();
        if g.jobs.values().filter(|j| j.state == State::Running).count() >= MAX_RUNNING {
            return Err(format!("Background job limit reached ({MAX_RUNNING}). Wait for running jobs to finish or cancel one."));
        }
        g.next += 1;
        let id = format!("bg_{}", g.next);
        g.order.push(id.clone());
        g.jobs.insert(id.clone(), Job { label: label.to_string(), state: State::Running, text: None, consumed: false, delivered: false, cancel });
        Ok(id)
    }

    /// `failed` means the command exited non-zero, timed out or was aborted; `text` is the full result text.
    pub fn settle(&self, id: &str, failed: bool, text: String) {
        if let Some(j) = self.lock().jobs.get_mut(id) {
            if j.state == State::Running { j.state = if failed { State::Failed } else { State::Completed }; j.text = Some(text); }
        }
        self.notify.notify_waiters();
    }

    pub fn cancel(&self, id: &str) -> String {
        let mut g = self.lock();
        let Some(j) = g.jobs.get_mut(id) else { return format!("Background job not found: {id}") };
        if j.state != State::Running { return format!("Background job {id} is already {}.", j.state.word()); }
        j.state = State::Cancelled;
        let _ = j.cancel.send(true);
        drop(g);
        self.notify.notify_waiters();
        format!("Cancelled background job {id}.")
    }

    /// Settled results not yet shown to the model, formatted as one `<system-notice>` (marks them delivered).
    pub fn take_notices(&self, save_full: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        let mut g = self.lock();
        let ids: Vec<String> = g.order.iter().filter(|id| g.jobs[*id].state != State::Running && g.jobs[*id].state != State::Cancelled && !g.jobs[*id].delivered && !g.jobs[*id].consumed).cloned().collect();
        if ids.is_empty() { return None; }
        let mut blocks = Vec::new();
        for id in &ids {
            let j = g.jobs.get_mut(id)?;
            j.delivered = true;
            let mut text = j.text.clone().unwrap_or_default();
            if text.chars().count() > NOTICE_INLINE_CHARS {
                let full = save_full(&text);
                text = format!("{}\n\n[Output truncated. Showing first 4,000 characters.]{}", text.chars().take(NOTICE_HEAD_CHARS).collect::<String>(), full.map_or(String::new(), |a| format!("\nFull output: artifact://{a}")));
            }
            blocks.push((id.clone(), collapse(&j.label), text, j.state));
        }
        let body = if blocks.len() == 1 {
            let (id, _, text, state) = &blocks[0];
            format!("Background job {id} has {}. Resume your work using the result below.\n\n{text}", if *state == State::Failed { "failed" } else { "completed" })
        } else {
            let list = blocks.iter().map(|(id, label, text, _)| format!("── Job {id} ({label}) ──\n{text}")).collect::<Vec<_>>().join("\n\n");
            format!("{} background jobs have completed. Resume your work using the results below.\n\n{list}", blocks.len())
        };
        Some(format!("<system-notice>\n{body}\n</system-notice>"))
    }

    fn report(&self, ids: &[String]) -> String {
        let mut g = self.lock();
        let (mut done, mut running) = (Vec::new(), Vec::new());
        for id in ids {
            let Some(j) = g.jobs.get(id) else { continue };
            if j.state == State::Running { running.push(format!("- `{id}` [bash] — {}", j.label)); } else { done.push(id.clone()); }
        }
        let mut lines: Vec<String> = Vec::new();
        if !done.is_empty() {
            lines.push(format!("## Completed ({})\n", done.len()));
            for id in &done {
                let j = g.jobs.get_mut(id).expect("listed");
                lines.push(format!("### {id} [bash] — {}", j.state.word()));
                lines.push(format!("Label: {}", j.label));
                if j.state != State::Cancelled {
                    lines.push(if j.consumed || j.delivered { "Delivery: already delivered or recovered.".into() } else { "Delivery: not auto-delivered; recovered by this snapshot.".into() });
                }
                if let Some(t) = &j.text { if j.state == State::Failed { lines.push(format!("Error: {t}")); } else { lines.extend(["```".into(), t.clone(), "```".into()]); } }
                j.consumed = true;
                lines.push(String::new());
            }
        }
        if !running.is_empty() { lines.push(format!("## Still Running ({})\n", running.len())); lines.extend(running); }
        if lines.is_empty() { "No background jobs.".into() } else { lines.join("\n").trim_end().to_string() }
    }

    pub async fn wait(&self, cap: Duration) -> Result<String, String> {
        let (running, undelivered): (Vec<String>, Vec<String>) = {
            let g = self.lock();
            (g.order.iter().filter(|i| g.jobs[*i].state == State::Running).cloned().collect(),
             g.order.iter().filter(|i| { let j = &g.jobs[*i]; j.state != State::Running && j.state != State::Cancelled && !j.consumed && !j.delivered }).cloned().collect())
        };
        if !undelivered.is_empty() { return Ok(self.report(&[undelivered, running].concat())); }
        if running.is_empty() { return Err("Nothing to wait for: no background job or service you started is running. Other agents' results and messages arrive on their own.".into()); }
        let deadline = tokio::time::Instant::now() + cap;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if running.iter().any(|id| self.lock().jobs[id].state != State::Running) { return Ok(self.report(&running)); }
            if tokio::time::timeout_at(deadline, notified).await.is_err() { return Ok(self.report(&running)); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(jobs: &Jobs, label: &str) -> String { jobs.register(label, watch::channel(false).0).unwrap() }
    #[tokio::test] async fn wait_returns_a_settled_job_then_marks_it_consumed() {
        let jobs = Jobs::default();
        let id = job(&jobs, "echo hi");
        assert_eq!(id, "bg_1");
        jobs.settle(&id, false, "hi".into());
        let r = jobs.wait(Duration::from_secs(1)).await.unwrap();
        assert!(r.starts_with("## Completed (1)\n\n### bg_1 [bash] — completed\nLabel: echo hi\nDelivery: not auto-delivered; recovered by this snapshot.\n```\nhi\n```"), "{r}");
        assert!(jobs.take_notices(&|_| None).is_none());
        assert!(jobs.wait(Duration::from_secs(1)).await.unwrap_err().starts_with("Nothing to wait for"));
    }
    #[tokio::test] async fn wait_blocks_until_a_job_settles_and_lists_still_running() {
        let jobs = std::sync::Arc::new(Jobs::default());
        let (a, b) = (job(&jobs, "a"), job(&jobs, "b"));
        let j2 = std::sync::Arc::clone(&jobs);
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(100)).await; j2.settle("bg_1", false, "A".into()); });
        let r = jobs.wait(Duration::from_secs(5)).await.unwrap();
        assert!(r.contains("### bg_1 [bash] — completed") && r.contains("## Still Running (1)\n\n- `bg_2` [bash] — b"), "{r}");
        let _ = (a, b);
    }
    #[test] fn notices_are_delivered_once_and_long_text_is_cut() {
        let jobs = Jobs::default();
        let id = job(&jobs, "long");
        jobs.settle(&id, false, "x".repeat(20_000));
        let n = jobs.take_notices(&|_| Some("7".into())).unwrap();
        assert!(n.starts_with("<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n\n") && n.contains("[Output truncated. Showing first 4,000 characters.]\nFull output: artifact://7"));
        assert!(jobs.take_notices(&|_| None).is_none());
    }
    #[test] fn cancel_messages_match_omp() {
        let jobs = Jobs::default();
        let id = job(&jobs, "x");
        assert_eq!(jobs.cancel(&id), "Cancelled background job bg_1.");
        assert_eq!(jobs.cancel(&id), "Background job bg_1 is already cancelled.");
        assert_eq!(jobs.cancel("bg_9"), "Background job not found: bg_9");
    }
    #[test] fn job_cap_is_enforced() {
        let jobs = Jobs::default();
        for _ in 0..MAX_RUNNING { job(&jobs, "x"); }
        assert!(jobs.register("y", watch::channel(false).0).unwrap_err().starts_with("Background job limit reached (100)."));
    }
}
