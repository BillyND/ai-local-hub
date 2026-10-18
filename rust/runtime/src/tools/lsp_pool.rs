//! Process-wide registry of live language-server clients (omp `getOrCreateClient` + failure backoff).
//! Every live MCP session of the workspace shares it, so concurrent conversations reuse one server per
//! config instead of each indexing the project again; when the last session ends the servers exit and free
//! their memory. A start runs detached: a caller that times out neither leaves a half-initialised server
//! behind nor makes the next call spawn a second one.
use super::{lsp_client::Client, lsp_config::ServerConfig};
use futures::future::{BoxFuture, FutureExt, Shared};
use std::{collections::HashMap, path::Path, sync::{atomic::{AtomicU64, AtomicUsize, Ordering}, Arc, LazyLock, Mutex, MutexGuard}, time::{Duration, Instant}};

const FAILURE_BACKOFF: Duration = Duration::from_secs(180);

type Start = Shared<BoxFuture<'static, Result<Arc<Client>, String>>>;

enum Slot { Ready(Arc<Client>), Starting(u64, Start) }

#[derive(Default)]
pub struct Pool { slots: Mutex<HashMap<String, Slot>>, failures: Mutex<HashMap<String, (Instant, String)>>, starts: AtomicU64, sessions: AtomicUsize }

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }

impl Pool {
    pub fn shared() -> Arc<Pool> {
        static POOL: LazyLock<Arc<Pool>> = LazyLock::new(Default::default);
        Arc::clone(&POOL)
    }

    pub fn session_started(&self) { self.sessions.fetch_add(1, Ordering::SeqCst); }

    /// The last live session ended: nothing can use the servers until a new session starts, so they exit.
    pub fn session_ended(self: &Arc<Self>) {
        if self.sessions.fetch_sub(1, Ordering::SeqCst) != 1 { return; }
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let pool = Arc::clone(self);
        handle.spawn(async move {
            let idle: Vec<Arc<Client>> = {
                let mut slots = lock(&pool.slots);
                if pool.sessions.load(Ordering::SeqCst) > 0 { return; }
                let keys: Vec<String> = slots.iter().filter(|(_, s)| matches!(s, Slot::Ready(_))).map(|(k, _)| k.clone()).collect();
                keys.into_iter().filter_map(|k| match slots.remove(&k) { Some(Slot::Ready(c)) => Some(c), _ => None }).collect()
            };
            futures::future::join_all(idle.iter().map(|c| c.shutdown())).await;
        });
    }

    /// Existing live client for this server config + cwd, the start already in flight, or a fresh one.
    pub async fn get(self: &Arc<Self>, cfg: &ServerConfig, cwd: &Path, timeout: Option<Duration>) -> Result<Arc<Client>, String> {
        let key = cfg.key(cwd);
        let start = {
            let mut slots = lock(&self.slots);
            // A start whose task died (panic) never ran `finish_start`: settle its slot from the result.
            let settled = match slots.get(&key) { Some(Slot::Starting(_, s)) => s.peek().cloned(), _ => None };
            match settled {
                Some(Ok(c)) => { slots.insert(key.clone(), Slot::Ready(c)); },
                Some(Err(_)) => { slots.remove(&key); },
                None => {},
            }
            match slots.get(&key) {
                Some(Slot::Ready(c)) if !c.exited.load(Ordering::SeqCst) => return Ok(Arc::clone(c)),
                Some(Slot::Starting(_, s)) => s.clone(),
                _ => {
                    if let Some((at, msg)) = lock(&self.failures).get(&key) {
                        if at.elapsed() < FAILURE_BACKOFF { return Err(format!("LSP server {} failed to initialize recently: {msg}", cfg.command)); }
                    }
                    let id = self.starts.fetch_add(1, Ordering::Relaxed);
                    let (pool, cfg, cwd, slot_key) = (Arc::clone(self), cfg.clone(), cwd.to_path_buf(), key.clone());
                    let task = tokio::spawn(async move {
                        let result = Client::start(&cfg, &cwd, timeout).await;
                        // A caller-shortened deadline says nothing about the server itself.
                        pool.finish_start(&slot_key, id, &result, timeout.is_none());
                        result
                    });
                    let start: Start = async move { task.await.unwrap_or_else(|e| Err(format!("LSP server start failed: {e}"))) }.boxed().shared();
                    slots.insert(key, Slot::Starting(id, start.clone()));
                    start
                },
            }
        };
        start.await
    }

    fn finish_start(&self, key: &str, id: u64, result: &Result<Arc<Client>, String>, record_failure: bool) {
        let mut slots = lock(&self.slots);
        let current = matches!(slots.get(key), Some(Slot::Starting(s, _)) if *s == id);
        match result {
            Ok(c) if current && self.sessions.load(Ordering::SeqCst) > 0 => { slots.insert(key.to_string(), Slot::Ready(Arc::clone(c))); },
            // Superseded by a reload, or every session ended while it started: nobody can reach it, so stop it.
            Ok(c) => {
                if current { slots.remove(key); }
                let c = Arc::clone(c);
                tokio::spawn(async move { c.shutdown().await; });
            },
            Err(e) => {
                if current { slots.remove(key); }
                if record_failure { lock(&self.failures).insert(key.to_string(), (Instant::now(), e.clone())); }
            },
        }
    }

    fn ready(&self) -> Vec<Arc<Client>> {
        lock(&self.slots).values().filter_map(|s| match s { Slot::Ready(c) => Some(Arc::clone(c)), Slot::Starting(..) => None }).collect()
    }

    pub async fn clients(&self) -> Vec<Arc<Client>> { self.ready() }

    pub fn forget_failure(&self, cfg: &ServerConfig, cwd: &Path) { lock(&self.failures).remove(&cfg.key(cwd)); }

    /// (config command, status) for every live client of `cwd`.
    pub async fn active(&self, cwd: &Path) -> Vec<(String, &'static str)> {
        self.ready().into_iter().filter(|c| c.cwd == cwd).map(|c| (c.name.clone(), if c.exited.load(Ordering::SeqCst) { "error" } else { "ready" })).collect()
    }

    /// Removes and stops `cwd`'s clients whose key is not in `keep`; returns their names.
    pub async fn stop_stale(&self, cwd: &Path, keep: &[String]) -> Vec<String> {
        let stale: Vec<Arc<Client>> = {
            let mut slots = lock(&self.slots);
            let gone: Vec<String> = slots.iter().filter(|(k, s)| !keep.contains(k) && matches!(s, Slot::Ready(c) if c.cwd == cwd)).map(|(k, _)| k.clone()).collect();
            gone.into_iter().filter_map(|k| match slots.remove(&k) { Some(Slot::Ready(c)) => Some(c), _ => None }).collect()
        };
        let mut names = Vec::new();
        for c in stale { c.shutdown().await; names.push(c.name.clone()); }
        names
    }

    /// Asks every live server to exit, in parallel (runtime shutdown).
    pub async fn shutdown_all(&self) {
        let clients: Vec<Arc<Client>> = lock(&self.slots).drain().filter_map(|(_, s)| match s { Slot::Ready(c) => Some(c), Slot::Starting(..) => None }).collect();
        futures::future::join_all(clients.iter().map(|c| c.shutdown())).await;
    }
}
