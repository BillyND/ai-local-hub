//! Cooperative stop for blocking tool bodies. They run on tokio's blocking pool so a long filesystem scan
//! never stalls the async workers; long loops poll `check()` and stop once the client cancelled the call,
//! the session ended, or the time budget ran out.
use std::{cell::RefCell, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;

struct Token { cancel: CancellationToken, deadline: Instant }

thread_local! { static CURRENT: RefCell<Option<Arc<Token>>> = const { RefCell::new(None) }; }

/// Set once the runtime starts shutting down: every running body stops at its next check.
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

pub fn begin_shutdown() { SHUTDOWN.store(true, Ordering::SeqCst); }

/// True once the call should stop. Always false outside `run_blocking`.
pub fn requested() -> bool {
    CURRENT.with(|c| c.borrow().as_ref().is_some_and(|t| SHUTDOWN.load(Ordering::Relaxed) || t.cancel.is_cancelled() || Instant::now() >= t.deadline))
}

pub fn check() -> Result<(), String> {
    if requested() { Err("Stopped: the call was cancelled or ran past its time budget. Narrow the path or pattern and retry.".into()) } else { Ok(()) }
}

/// Clears the thread's token even when the body panics, so a reused pool thread never inherits it.
struct Scope;
impl Drop for Scope { fn drop(&mut self) { CURRENT.with(|c| *c.borrow_mut() = None); } }

/// Runs `body` on the blocking pool. `cancel` firing, the returned future being dropped, or `budget`
/// elapsing makes `requested()` true inside the body. A panic becomes an error instead of killing the call.
pub async fn run_blocking<T: Send + 'static>(cancel: CancellationToken, budget: Duration, body: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let token = Arc::new(Token { cancel: cancel.child_token(), deadline: Instant::now() + budget });
    let _stop_on_drop = token.cancel.clone().drop_guard();
    let job = tokio::task::spawn_blocking(move || {
        CURRENT.with(|c| *c.borrow_mut() = Some(token));
        let _scope = Scope;
        body()
    });
    job.await.map_err(|e| match e.try_into_panic() {
        Ok(panic) => format!("Internal error: {}", panic.downcast_ref::<&str>().copied().or_else(|| panic.downcast_ref::<String>().map(String::as_str)).unwrap_or("tool panicked")),
        Err(_) => "Internal error: tool task was aborted".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test] async fn budget_and_cancellation_reach_the_body() {
        assert!(!requested());
        let open = run_blocking(CancellationToken::new(), Duration::from_secs(60), requested).await.unwrap();
        assert!(!open);
        let expired = run_blocking(CancellationToken::new(), Duration::ZERO, requested).await.unwrap();
        assert!(expired);
        let ct = CancellationToken::new();
        ct.cancel();
        assert!(run_blocking(ct, Duration::from_secs(60), || check().is_err()).await.unwrap());
    }
    #[tokio::test] async fn panics_become_errors() {
        let r = run_blocking(CancellationToken::new(), Duration::from_secs(5), || -> u8 { panic!("boom") }).await;
        assert_eq!(r.unwrap_err(), "Internal error: boom");
    }
}
