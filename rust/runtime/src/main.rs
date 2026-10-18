use ai_local_hub_runtime::{gateway::Gateway, tools::{pdf_worker_main, CodingTools, PDF_WORKER_FLAG}, tunnel};

use anyhow::{Context, Result};
use axum::{http::{HeaderMap, StatusCode}, middleware::{self, Next}, response::Response, routing::get, Router};
use rmcp::transport::{
    streamable_http_server::{session::{local::LocalSessionManager, SessionManager}, tower::StreamableHttpService},
    StreamableHttpServerConfig,
};
use std::{env, path::PathBuf, sync::{Arc, OnceLock}, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpListener, signal, sync::watch};
use tokio_util::sync::CancellationToken;

/// An MCP session idle this long is closed and its background jobs stopped. Long enough that a dev server
/// started with `timeout: 0` survives the user testing it for a while between turns.
const SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
/// After shutdown begins, open HTTP connections get this long before they are dropped. The manager
/// force-kills a worker after 10 s, and a force-killed worker cannot stop its children.
const HTTP_DRAIN: Duration = Duration::from_secs(2);
/// Blocking-pool work still running at exit (a scan finishing its batch, the stdin reader, which cannot be
/// cancelled) gets this long before the process leaves it behind.
const BLOCKING_DRAIN: Duration = Duration::from_millis(500);
/// The instance keeps answering while slow MCP servers finish starting in the background.
const MCP_STARTUP_WAIT: Duration = Duration::from_secs(30);

fn emit(value: serde_json::Value) {
    println!("{}", value);
}
async fn validate_local(axum::extract::State(port): axum::extract::State<u16>, headers: HeaderMap, request: axum::extract::Request, next: Next) -> Result<Response, StatusCode> {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    // Reject forged Host/Origin values, even on the loopback-only listener.
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if origin != format!("http://{}", host) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(request).await)
}
async fn stop_requested(rx: &mut watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() { std::future::pending::<()>().await; }
    }
}
async fn run(gateway_slot: &OnceLock<Arc<Gateway>>) -> Result<()> {
    let workspace = env::var("WORKSPACE_ROOT").context("WORKSPACE_ROOT is required")?;
    let workspace = PathBuf::from(workspace).canonicalize().context("workspace does not exist")?;
    if !workspace.is_dir() { anyhow::bail!("workspace must be a directory"); }
    let local_only = env::args().any(|arg| arg == "--local-only");
    // Remove the token from the process environment before any arbitrary bash tool can be called.
    let api_key = env::var("OPENAI_API_KEY").unwrap_or_default();
    env::remove_var("OPENAI_API_KEY");
    let mcp_servers = Gateway::servers_from_env().map_err(|e| anyhow::anyhow!(e))?;
    let client_id = env::var("OPENAI_TUNNEL_ID").unwrap_or_default();
    let binary = env::var("WORKSPACE_TOOLS_TUNNEL_BIN").unwrap_or_default();
    let cache_dir = env::var("WORKSPACE_TOOLS_CACHE_DIR").unwrap_or_default();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let stdin_shutdown = shutdown_tx.clone();
    // Detect parent disappearance: manager owns the pipe, EOF is a hard stop. Watched from the start so a
    // stop during MCP server startup or tunnel connect is honoured before the manager escalates to SIGKILL.
    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut byte = [0u8; 1];
        loop {
            match stdin.read(&mut byte).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        let _ = stdin_shutdown.send(true);
    });

    emit(serde_json::json!({"type":"log","message":"Full filesystem and shell permissions enabled; the workspace is not a sandbox."}));
    emit(serde_json::json!({"type":"log","message":format!("Workspace: {}", workspace.display())}));
    emit(serde_json::json!({"type":"phase","message":"Starting Rust MCP server"}));
    let groups = ai_local_hub_runtime::tools::ToolGroups::from_env()
        .map_err(|e| anyhow::anyhow!("invalid AI_LOCAL_HUB_TOOL_GROUPS: {e}"))?;
    if let Ok(exe) = env::current_exe() { CodingTools::enable_pdf_worker(exe); }
    if !mcp_servers.is_empty() {
        emit(serde_json::json!({"type":"phase","message":"Starting MCP servers"}));
        emit(serde_json::json!({"type":"log","message":format!("MCP servers: {}", mcp_servers.keys().cloned().collect::<Vec<_>>().join(", "))}));
    }
    let gateway = gateway_slot.get_or_init(|| Gateway::start(mcp_servers, &workspace)).clone();
    tokio::select! {
        _ = gateway.wait_started(MCP_STARTUP_WAIT) => {},
        _ = stop_requested(&mut shutdown_rx) => return Ok(()),
    }

    let sessions = CancellationToken::new();
    let mut session_manager = LocalSessionManager::default();
    session_manager.session_config.keep_alive = Some(SESSION_IDLE);
    let session_manager = Arc::new(session_manager);
    let service: StreamableHttpService<CodingTools, LocalSessionManager> = StreamableHttpService::new(
        { let workspace = workspace.clone(); let groups = groups.clone(); let gateway = gateway.clone(); move || Ok(CodingTools::with_groups(workspace.clone(), groups.clone()).with_gateway(gateway.clone())) },
        Arc::clone(&session_manager),
        StreamableHttpServerConfig::default().with_cancellation_token(sessions.clone()),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind loopback MCP")?;
    let port = listener.local_addr()?.port();
    let app = Router::new()
        .route("/healthz", get(|| async { axum::Json(serde_json::json!({"ready":true})) }))
        .route("/readyz", get(|| async { axum::Json(serde_json::json!({"ready":true})) }))
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(port, validate_local));
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    emit(serde_json::json!({"type":"mcp","url":mcp_url}));
    emit(serde_json::json!({"type":"log","message":format!("MCP ready: {mcp_url}")}));
    let tool_names = CodingTools::with_groups(workspace.clone(), groups.clone()).with_gateway(gateway.clone()).tool_names_for_instance();
    emit(serde_json::json!({"type":"log","message":format!("Tools ({}): {}", tool_names.len(), tool_names.join(", "))}));
    let mut shutdown_http = shutdown_rx.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                while !*shutdown_http.borrow() {
                    if shutdown_http.changed().await.is_err() { break; }
                }
            })
            .await
    });
    let mut tunnel = None;
    let mut runtime_dir = None;
    if !local_only {
        if binary.is_empty() || api_key.is_empty() || client_id.is_empty() {
            anyhow::bail!("Tunnel binary, ID, or runtime key is missing");
        }
        emit(serde_json::json!({"type":"phase","message":"Connecting tunnel"}));
        let dir = PathBuf::from(cache_dir).join("runtime").join(format!("ai-local-hub-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await?; }
        runtime_dir = Some(dir.clone());
        let connected = tokio::select! {
            r = tunnel::connect(&binary, &dir, &client_id, &api_key, &mcp_url) => Some(r),
            _ = stop_requested(&mut shutdown_rx) => None,
        };
        let child = match connected {
            Some(Ok(child)) => child,
            Some(Err(error)) => {
                let _ = tokio::fs::remove_dir_all(&dir).await;
                return Err(error);
            }
            // The pending tunnel-client is killed on drop.
            None => { let _ = tokio::fs::remove_dir_all(&dir).await; return Ok(()); }
        };
        tunnel = Some(child);
        emit(serde_json::json!({"type":"log","message":"OpenAI tunnel ready"}));
    }
    emit(serde_json::json!({"type":"ready","tunnel":!local_only}));
    let tunnel_exit = tokio::select! {
        _ = stop_requested(&mut shutdown_rx) => None,
        _ = signal::ctrl_c() => None,
        _ = terminated() => None,
        status = async {
            if let Some(t) = tunnel.as_mut() { t.wait().await.ok() } else { std::future::pending().await }
        } => Some(status),
    };
    if let Some(mut child) = tunnel {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    // End the SSE streams and close every MCP session (their background jobs stop), stop language
    // servers and command trees, then stop external servers before draining HTTP connections.
    sessions.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let ids: Vec<_> = session_manager.sessions.read().await.keys().cloned().collect();
        for id in ids { let _ = session_manager.close_session(&id).await; }
    }).await;
    CodingTools::shutdown_children().await;
    gateway.shutdown().await;
    let _ = shutdown_tx.send(true);
    let mut server = server;
    if tokio::time::timeout(HTTP_DRAIN, &mut server).await.is_err() { server.abort(); }
    if let Some(dir) = runtime_dir { let _ = tokio::fs::remove_dir_all(dir).await; }
    if let Some(status) = tunnel_exit { anyhow::bail!("tunnel-client exited unexpectedly: {status:?}"); }
    Ok(())
}
/// SIGTERM (e.g. `kill`, system shutdown) gets the same clean stop as Ctrl+C.
async fn terminated() {
    #[cfg(unix)]
    if let Ok(mut term) = signal::unix::signal(signal::unix::SignalKind::terminate()) { term.recv().await; return; }
    std::future::pending::<()>().await
}
fn main() {
    let mut args = env::args_os().skip(1);
    if args.next().is_some_and(|arg| arg == PDF_WORKER_FLAG) { std::process::exit(pdf_worker_main(args.next())); }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(error) => { emit(serde_json::json!({"type":"fatal","message":format!("Cannot start the async runtime: {error}")})); std::process::exit(1); }
    };
    let outcome = runtime.block_on(async {
        let gateway = OnceLock::new();
        let outcome = run(&gateway).await;
        if outcome.is_err() { CodingTools::shutdown_children().await; }
        if let Some(gateway) = gateway.get() { gateway.shutdown().await; }
        outcome
    });
    // Dropping the runtime would wait for every blocking task, without limit.
    runtime.shutdown_timeout(BLOCKING_DRAIN);
    if let Err(error) = outcome {
        emit(serde_json::json!({"type":"fatal","message":format!("{error:#}")}));
        std::process::exit(1);
    }
}
