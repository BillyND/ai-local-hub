use ai_local_hub_runtime::{tools::CodingTools,tunnel};

use anyhow::{Context, Result};
use axum::{http::{HeaderMap, StatusCode}, middleware::{self, Next}, response::Response, routing::get, Router};
use rmcp::transport::{
    streamable_http_server::{session::local::LocalSessionManager, tower::StreamableHttpService},
    StreamableHttpServerConfig,
};
use std::{env, path::PathBuf};
use tokio::{io::AsyncReadExt, net::TcpListener, signal, sync::watch};

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
async fn run() -> Result<()> {
    let workspace = env::var("WORKSPACE_ROOT").context("WORKSPACE_ROOT is required")?;
    let workspace = PathBuf::from(workspace).canonicalize().context("workspace does not exist")?;
    if !workspace.is_dir() { anyhow::bail!("workspace must be a directory"); }
    let local_only = env::args().any(|arg| arg == "--local-only");
    // Remove the token from the process environment before any arbitrary bash tool can be called.
    let api_key = env::var("OPENAI_API_KEY").unwrap_or_default();
    env::remove_var("OPENAI_API_KEY");
    let client_id = env::var("OPENAI_TUNNEL_ID").unwrap_or_default();
    let binary = env::var("WORKSPACE_TOOLS_TUNNEL_BIN").unwrap_or_default();
    let cache_dir = env::var("WORKSPACE_TOOLS_CACHE_DIR").unwrap_or_default();

    emit(serde_json::json!({"type":"log","message":"Full filesystem and shell permissions enabled; the workspace is not a sandbox."}));
    emit(serde_json::json!({"type":"log","message":format!("Workspace: {}",workspace.display())}));
    emit(serde_json::json!({"type":"phase","message":"Starting Rust MCP server"}));
    let service: StreamableHttpService<CodingTools, LocalSessionManager> = StreamableHttpService::new(
        { let workspace=workspace.clone(); move || Ok(CodingTools::new(workspace.clone())) },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind loopback MCP")?;
    let port = listener.local_addr()?.port();
    let app = Router::new()
        .route("/healthz", get(|| async { axum::Json(serde_json::json!({"ready":true})) }))
        .route("/readyz", get(|| async { axum::Json(serde_json::json!({"ready":true})) }))
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(port,validate_local));
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    emit(serde_json::json!({"type":"mcp","url":mcp_url}));
    emit(serde_json::json!({"type":"log","message":format!("MCP ready: {mcp_url}")}));
    let tool_names=CodingTools::tool_names();
    emit(serde_json::json!({"type":"log","message":format!("Tools ({}): {}",tool_names.len(),tool_names.join(", "))}));
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
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
    let stdin_shutdown = shutdown_tx.clone();
    // Detect parent disappearance: manager owns the pipe, EOF is a hard stop.
    tokio::spawn(async move {
        let mut stdin=tokio::io::stdin();
        let mut byte=[0u8;1];
        loop {
            match stdin.read(&mut byte).await {
                Ok(0)|Err(_) => break,
                Ok(_) => continue,
            }
        }
        let _=stdin_shutdown.send(true);
    });
    let mut tunnel = None;
    let mut runtime_dir = None;
    if !local_only {
        if binary.is_empty() || api_key.is_empty() || client_id.is_empty() {
            anyhow::bail!("Tunnel binary, ID, or runtime key is missing");
        }
        emit(serde_json::json!({"type":"phase","message":"Connecting tunnel"}));
        let dir = PathBuf::from(cache_dir).join("runtime").join(format!("ai-local-hub-{}",uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        {use std::os::unix::fs::PermissionsExt;tokio::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).await?;}
        runtime_dir = Some(dir.clone());
        let child=match tunnel::connect(&binary, &dir, &client_id, &api_key, &mcp_url).await {
            Ok(child)=>child,
            Err(error)=>{
                let _=tokio::fs::remove_dir_all(&dir).await;
                return Err(error);
            }
        };
        tunnel = Some(child);
        emit(serde_json::json!({"type":"log","message":"OpenAI tunnel ready"}));
    }
    emit(serde_json::json!({"type":"ready","tunnel":!local_only}));
    tokio::select! {
        _=async {
            while !*shutdown_rx.borrow() {
                if shutdown_rx.changed().await.is_err() { break; }
            }
        }=>{},
        _=signal::ctrl_c()=>{},
        status=async {
            if let Some(t)=tunnel.as_mut() {t.wait().await.ok()} else {std::future::pending().await}
        } => {anyhow::bail!("tunnel-client exited unexpectedly: {status:?}");}
    }
    if let Some(mut child)=tunnel {
        let _=child.start_kill();
        let _=child.wait().await;
    }
    let _=shutdown_tx.send(true);
    let _=server.await;
    if let Some(dir)=runtime_dir {let _=tokio::fs::remove_dir_all(dir).await;}
    Ok(())
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        emit(serde_json::json!({"type":"fatal","message":format!("{error:#}")}));
        std::process::exit(1);
    }
}
