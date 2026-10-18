//! Keeps one upstream MCP server connected: start, initialize, list tools, restart with backoff.
use super::{child::{self, Process}, expose, log};
use crate::mcp_servers::McpServerConfig;
use rmcp::{model::{CallToolRequest, CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, ClientRequest, ContentBlock, Implementation, JsonObject, ServerResult, Tool}, service::{NotificationContext, Peer, PeerRequestOptions, RunningService, ServiceError}, ClientHandler, RoleClient, ServiceExt};
use std::{collections::HashSet, future::Future, path::PathBuf, sync::{Arc, RwLock}, time::{Duration, Instant}};
use tokio::sync::{watch, Notify};

/// First-run `npx`/`uvx` downloads can be slow; anything slower is treated as a failed start.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// A connection that stayed up this long resets the restart backoff.
const STABLE_AFTER: Duration = Duration::from_secs(60);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_CHECK: Duration = Duration::from_secs(2);

/// Client side of the upstream connection; server logs arrive on stderr (see `child`).
struct Handler { refresh: Arc<Notify> }
impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(ClientCapabilities::default(), Implementation::new("ai-local-hub", env!("CARGO_PKG_VERSION")))
    }
    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) { self.refresh.notify_one(); }
}

#[derive(Clone)]
struct Exposed { tool: Tool, original: String }
struct State { peer: Option<Peer<RoleClient>>, status: String, tools: Vec<Exposed> }

pub struct Upstream { pub name: String, spec: McpServerConfig, workspace: PathBuf, state: RwLock<State>, refresh: Arc<Notify>, settled: watch::Sender<bool> }

fn error(text: String) -> CallToolResult { CallToolResult::error(vec![ContentBlock::text(text)]) }

impl Upstream {
    pub fn new(name: String, spec: McpServerConfig, workspace: PathBuf) -> Arc<Self> {
        let state = State { peer: None, status: "starting".into(), tools: Vec::new() };
        Arc::new(Self { name, spec, workspace, state: RwLock::new(state), refresh: Arc::new(Notify::new()), settled: watch::Sender::new(false) })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> { self.state.read().unwrap_or_else(|e| e.into_inner()) }
    fn write(&self) -> std::sync::RwLockWriteGuard<'_, State> { self.state.write().unwrap_or_else(|e| e.into_inner()) }

    /// Last known tools; they stay listed while the server restarts so the client's cached list stays valid.
    pub fn tools(&self) -> Vec<Tool> { self.read().tools.iter().map(|e| e.tool.clone()).collect() }
    pub fn original(&self, exposed: &str) -> Option<String> { self.read().tools.iter().find(|e| e.tool.name == exposed).map(|e| e.original.clone()) }
    pub fn settled(&self) -> watch::Receiver<bool> { self.settled.subscribe() }

    fn expose(&self, upstream: Vec<Tool>) -> Vec<Exposed> {
        let allow: HashSet<&str> = self.spec.tools.iter().map(String::as_str).collect();
        let present: HashSet<&str> = upstream.iter().map(|t| t.name.as_ref()).collect();
        for missing in allow.iter().filter(|n| !present.contains(*n)) { log(format!("MCP server {}: allowlisted tool `{missing}` does not exist", self.name)); }
        let mut taken = HashSet::new();
        upstream.into_iter().filter(|t| allow.is_empty() || allow.contains(t.name.as_ref())).map(|t| {
            let name = expose::exposed_name(&self.name, &t.name, &taken);
            taken.insert(name.clone());
            Exposed { tool: expose::present(&self.name, &t, name, self.spec.trust_annotations), original: t.name.to_string() }
        }).collect()
    }

    async fn connect(&self) -> Result<(Process, RunningService<RoleClient, Handler>, Vec<Tool>), String> {
        let (mut process, stdout, stdin) = child::spawn(&self.name, &self.spec, &self.workspace)?;
        let handler = Handler { refresh: Arc::clone(&self.refresh) };
        let started = async {
            let service = handler.serve((stdout, stdin)).await.map_err(|e| format!("initialize failed: {e}"))?;
            let tools = service.peer().list_all_tools().await.map_err(|e| format!("tools/list failed: {e}"))?;
            Ok::<_, String>((service, tools))
        };
        let outcome = tokio::select! {
            r = tokio::time::timeout(START_TIMEOUT, started) => r.unwrap_or_else(|_| Err(format!("no response within {}s", START_TIMEOUT.as_secs()))),
            exit = process.exited() => Err(format!("{exit} during startup")),
        };
        match outcome {
            Ok((service, tools)) => Ok((process, service, tools)),
            Err(e) => { process.terminate().await; Err(e) }
        }
    }

    fn set_down(&self, status: String) {
        let mut state = self.write();
        state.peer = None;
        state.status = status;
    }

    /// Runs until `shutdown` flips to true; the process group is always terminated before returning.
    pub async fn supervise(self: Arc<Self>, mut shutdown: watch::Receiver<bool>) {
        let mut backoff = Duration::from_secs(1);
        while !*shutdown.borrow() {
            let started = Instant::now();
            // Dropping a pending start kills its process group (see `Process::drop`).
            let connected = tokio::select! { r = self.connect() => r, _ = shutdown.changed() => break };
            match connected {
                Ok((mut process, service, tools)) => {
                    let exposed = self.expose(tools);
                    log(format!("MCP server {} ready: {} tools ({})", self.name, exposed.len(), exposed.iter().map(|e| e.tool.name.to_string()).collect::<Vec<_>>().join(", ")));
                    { let mut state = self.write(); state.peer = Some(service.peer().clone()); state.status = "ready".into(); state.tools = exposed; }
                    self.settled.send_replace(true);
                    let mut health = tokio::time::interval(HEALTH_CHECK);
                    let reason = 'connected: loop {
                        tokio::select! {
                            exit = process.exited() => break exit,
                            // A server can close its stdio loop yet keep running (e.g. a stray non-daemon thread).
                            _ = health.tick() => if service.peer().is_transport_closed() { break "closed its connection".to_string() },
                            _ = self.refresh.notified() => tokio::select! {
                                listed = tokio::time::timeout(REFRESH_TIMEOUT, service.peer().list_all_tools()) => match listed {
                                    Ok(Ok(tools)) => { let exposed = self.expose(tools); log(format!("MCP server {} tool list changed: {} tools", self.name, exposed.len())); self.write().tools = exposed; }
                                    Ok(Err(e)) => log(format!("MCP server {}: tools/list refresh failed: {e}", self.name)),
                                    Err(_) => log(format!("MCP server {}: tools/list refresh timed out; keeping the previous list", self.name)),
                                },
                                _ = shutdown.changed() => break 'connected "stopped".to_string(),
                            },
                            _ = shutdown.changed() => break "stopped".to_string(),
                        }
                    };
                    self.set_down(reason.clone());
                    drop(service);
                    process.terminate().await;
                    if *shutdown.borrow() { break; }
                    log(format!("MCP server {} {reason}; restarting", self.name));
                    if started.elapsed() >= STABLE_AFTER { backoff = Duration::from_secs(1); }
                }
                Err(e) => {
                    log(format!("MCP server {} failed to start: {e}; retrying in {}s", self.name, backoff.as_secs()));
                    self.set_down(e);
                    self.settled.send_replace(true);
                }
            }
            tokio::select! { _ = tokio::time::sleep(backoff) => {}, _ = shutdown.changed() => {} }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
        self.set_down("stopped".into());
    }

    /// Forwards one call. Times out under the tunnel limit and tells the server to cancel.
    pub async fn call(&self, original: String, arguments: Option<JsonObject>, cancel: impl Future<Output = ()>) -> CallToolResult {
        let (peer, status) = { let state = self.read(); (state.peer.clone(), state.status.clone()) };
        let Some(peer) = peer else {
            return error(format!("MCP server '{}' is not connected ({status}). It restarts automatically; retry in a few seconds.", self.name));
        };
        let mut params = CallToolRequestParams::new(original);
        if let Some(arguments) = arguments { params = params.with_arguments(arguments); }
        let mut handle = match peer.send_request_with_option(ClientRequest::CallToolRequest(CallToolRequest::new(params)), PeerRequestOptions::no_options()).await {
            Ok(handle) => handle,
            Err(e) => return error(format!("MCP server '{}' is unavailable: {e}", self.name)),
        };
        let limit = Duration::from_secs(self.spec.timeout_secs);
        let response = tokio::select! {
            r = &mut handle.rx => r.unwrap_or(Err(ServiceError::TransportClosed)),
            _ = tokio::time::sleep(limit) => {
                let _ = handle.cancel(Some("timeout".into())).await;
                return error(format!("MCP server '{}' did not answer within {}s; the call was cancelled. Raise its timeoutSecs (max 110) for slow tools.", self.name, limit.as_secs()));
            }
            _ = cancel => {
                let _ = handle.cancel(Some("cancelled by client".into())).await;
                return error("Cancelled.".into());
            }
        };
        match response {
            Ok(ServerResult::CallToolResult(result)) => expose::fit(result, expose::RESULT_BUDGET),
            Ok(ServerResult::InputRequiredResult(_)) => error(format!("MCP server '{}' asked for interactive input, which the hub cannot provide.", self.name)),
            Ok(ServerResult::CreateTaskResult(_)) => error(format!("MCP server '{}' started an asynchronous task, which the hub does not support.", self.name)),
            Ok(_) => error(format!("MCP server '{}' sent an unexpected response.", self.name)),
            Err(ServiceError::TransportClosed) => error(format!("MCP server '{}' disconnected during the call; it restarts automatically.", self.name)),
            Err(ServiceError::McpError(e)) => error(format!("MCP server '{}' rejected the call: {}", self.name, e.message)),
            Err(e) => error(format!("MCP server '{}' call failed: {e}", self.name)),
        }
    }
}
