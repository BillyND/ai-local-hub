//! Gateway to external stdio MCP servers: one connection per server per instance (shared by every
//! client session), tools re-exposed as `<server>__<tool>` next to the native tools.
mod child;
mod expose;
mod upstream;

use crate::mcp_servers::{self, McpServers};
use rmcp::model::{CallToolResult, JsonObject, Tool};
use std::{future::Future, path::Path, sync::{Arc, Mutex}, time::Duration};
use tokio::{sync::watch, task::JoinHandle, time::Instant};
use upstream::Upstream;

/// JSON map of enabled servers, set by the manager and removed before any tool can run.
pub const ENV: &str = "AI_LOCAL_HUB_MCP_SERVERS";
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);

pub(crate) fn log(message: String) {
    println!("{}", serde_json::json!({"type": "log", "message": message}));
}

pub struct Gateway { upstreams: Vec<Arc<Upstream>>, shutdown: watch::Sender<bool>, tasks: Mutex<Vec<JoinHandle<()>>> }

impl Gateway {
    pub fn empty() -> Arc<Self> { Arc::new(Self { upstreams: Vec::new(), shutdown: watch::Sender::new(false), tasks: Mutex::new(Vec::new()) }) }

    /// Reads the server list and removes it from the environment: env values may hold secrets.
    pub fn servers_from_env() -> Result<McpServers, String> {
        let raw = std::env::var(ENV).unwrap_or_default();
        std::env::remove_var(ENV);
        if raw.trim().is_empty() { return Ok(McpServers::new()); }
        let servers: McpServers = serde_json::from_str(&raw).map_err(|e| format!("invalid {ENV}: {e}"))?;
        mcp_servers::normalize(servers).map_err(|e| e.to_string())
    }

    /// Starts one supervisor per enabled server; tools appear as each server becomes ready.
    pub fn start(servers: McpServers, workspace: &Path) -> Arc<Self> {
        let shutdown = watch::Sender::new(false);
        let upstreams: Vec<_> = servers.into_iter().filter(|(_, s)| s.enabled).map(|(name, spec)| Upstream::new(name, spec, workspace.to_path_buf())).collect();
        let tasks = upstreams.iter().map(|u| tokio::spawn(Arc::clone(u).supervise(shutdown.subscribe()))).collect();
        Arc::new(Self { upstreams, shutdown, tasks: Mutex::new(tasks) })
    }

    /// Waits until every server has finished its first start attempt, or until `limit`.
    pub async fn wait_started(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        for upstream in &self.upstreams {
            let mut settled = upstream.settled();
            while !*settled.borrow_and_update() {
                if tokio::time::timeout_at(deadline, settled.changed()).await.map_or(true, |r| r.is_err()) {
                    log(format!("MCP server {} is still starting; its tools appear once it is ready (refresh the connector in ChatGPT).", upstream.name));
                    break;
                }
            }
        }
    }

    pub fn tools(&self) -> Vec<Tool> { self.upstreams.iter().flat_map(|u| u.tools()).collect() }

    pub fn tool(&self, name: &str) -> Option<Tool> { self.tools().into_iter().find(|t| t.name == name) }

    /// `None` when no external server exposes `name`.
    pub async fn call(&self, name: &str, arguments: Option<JsonObject>, cancel: impl Future<Output = ()>) -> Option<CallToolResult> {
        for upstream in &self.upstreams {
            if let Some(original) = upstream.original(name) { return Some(upstream.call(original, arguments, cancel).await); }
        }
        None
    }

    /// Stops every server and waits briefly for their process groups to be terminated.
    pub async fn shutdown(&self) {
        self.shutdown.send_replace(true);
        let mut tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        if tokio::time::timeout(SHUTDOWN_WAIT, futures::future::join_all(tasks.iter_mut())).await.is_err() {
            // Aborting drops each pending `Process`, whose `Drop` kills its group; `process::exit` would skip that.
            let pending: Vec<_> = tasks.into_iter().filter(|t| !t.is_finished()).collect();
            for task in &pending { task.abort(); }
            let _ = tokio::time::timeout(Duration::from_secs(1), futures::future::join_all(pending)).await;
        }
    }
}
