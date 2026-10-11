//! Registry of live language-server clients for one MCP session (omp `getOrCreateClient` + failure backoff).
use super::{lsp_client::Client, lsp_config::ServerConfig};
use std::{collections::HashMap, path::Path, sync::{atomic::Ordering, Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::Mutex as AMutex;

const FAILURE_BACKOFF: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct Pool { clients: AMutex<HashMap<String, Arc<Client>>>, failures: Mutex<HashMap<String, (Instant, String)>> }

impl Pool {
    /// Existing live client for this server config + cwd, or a freshly initialised one.
    pub async fn get(&self, cfg: &ServerConfig, cwd: &Path, timeout: Option<Duration>) -> Result<Arc<Client>, String> {
        let key = cfg.key(cwd);
        let mut clients = self.clients.lock().await;
        if let Some(c) = clients.get(&key) {
            if !c.exited.load(Ordering::SeqCst) { return Ok(Arc::clone(c)); }
            clients.remove(&key);
        }
        if let Some((at, msg)) = self.failures.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            if at.elapsed() < FAILURE_BACKOFF { return Err(format!("LSP server {} failed to initialize recently: {msg}", cfg.command)); }
        }
        match Client::start(cfg, cwd, timeout).await {
            Ok(c) => { clients.insert(key, Arc::clone(&c)); Ok(c) },
            Err(e) => {
                // A caller-shortened deadline says nothing about the server itself.
                if timeout.is_none() { self.failures.lock().unwrap_or_else(|x| x.into_inner()).insert(key, (Instant::now(), e.clone())); }
                Err(e)
            },
        }
    }

    pub async fn clients(&self) -> Vec<Arc<Client>> { self.clients.lock().await.values().cloned().collect() }

    pub fn forget_failure(&self, cfg: &ServerConfig, cwd: &Path) { self.failures.lock().unwrap_or_else(|e| e.into_inner()).remove(&cfg.key(cwd)); }

    /// (config command, status) for every client this session started.
    pub async fn active(&self) -> Vec<(String, &'static str)> {
        self.clients.lock().await.values().map(|c| (c.name.clone(), if c.exited.load(Ordering::SeqCst) { "error" } else { "ready" })).collect()
    }

    /// Removes and stops clients whose key is not in `keep`; returns their names.
    pub async fn stop_stale(&self, keep: &[String]) -> Vec<String> {
        let stale: Vec<(String, Arc<Client>)> = { let mut c = self.clients.lock().await; let gone: Vec<String> = c.keys().filter(|k| !keep.contains(k)).cloned().collect(); gone.into_iter().filter_map(|k| c.remove(&k).map(|v| (k, v))).collect() };
        let mut names = Vec::new();
        for (_, c) in stale { c.shutdown().await; names.push(c.name.clone()); }
        names
    }

}

impl Drop for Pool {
    /// A client's reader task keeps it alive, so stop the language servers explicitly when the session ends.
    fn drop(&mut self) {
        let clients: Vec<Arc<Client>> = self.clients.get_mut().drain().map(|(_, c)| c).collect();
        if clients.is_empty() { return; }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { for c in clients { c.shutdown().await; } });
        }
    }
}
