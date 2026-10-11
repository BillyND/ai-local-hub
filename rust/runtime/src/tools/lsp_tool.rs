//! omp `lsp`: symbol-aware navigation, refactors and diagnostics through language servers.
use super::{lsp_actions, lsp_client::{file_to_uri, Client}, lsp_config::{self, ServerConfig}, lsp_edits, lsp_format as fmt, lsp_pool::Pool, lsp_position::resolve_symbol_column, search_paths::{format_rel_cwd, resolve_to_cwd}};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};

pub struct Ctx { pub root: PathBuf, pub pool: Arc<Pool>, pub server: Mutex<String> }

pub struct Input { pub action: String, pub file: Option<String>, pub line: Option<f64>, pub symbol: Option<String>, pub query: Option<String>, pub new_name: Option<String>, pub apply: Option<bool>, pub timeout: Option<f64>, pub payload: Option<String> }

pub const READONLY: &[&str] = &["diagnostics", "definition", "type_definition", "implementation", "references", "hover", "symbols", "status", "capabilities"];
const WRITE_ACTIONS: &[&str] = &["rename", "rename_file", "code_actions", "reload", "request"];
const PROJECT_INDEXED: &[&str] = &["definition", "type_definition", "implementation", "references", "rename", "hover"];
const REFERENCE_CONTEXT_LIMIT: usize = 50;
const REFERENCES_RETRY: usize = 2;

type Out = Result<String, String>;

fn ok(s: impl Into<String>) -> Out { Ok(s.into()) }

pub async fn run(ctx: &Ctx, input: Input) -> Out {
    if !READONLY.contains(&input.action.as_str()) && !WRITE_ACTIONS.contains(&input.action.as_str()) { return ok(format!("Unknown action: {}", input.action)); }
    let secs = input.timeout.filter(|t| t.is_finite()).unwrap_or(20.0).clamp(5.0, 300.0);
    let action = input.action.clone();
    match tokio::time::timeout(Duration::from_secs_f64(secs), dispatch(ctx, input, secs)).await {
        Ok(r) => r,
        Err(_) => Err(format!("LSP {action} timed out after {}s on {}. The server may still be indexing; try again or pass timeout=<larger>.", secs as u64, ctx.server.lock().unwrap_or_else(|e| e.into_inner()))),
    }
}

async fn dispatch(ctx: &Ctx, input: Input, secs: f64) -> Out {
    let servers = lsp_config::load(&ctx.root);
    let action = input.action.as_str();
    match action {
        "status" => return lsp_actions::status(ctx, &servers).await,
        "diagnostics" => return lsp_actions::diagnostics(ctx, &servers, &input, secs).await,
        "rename_file" => return lsp_actions::rename_file(ctx, &servers, &input).await,
        "capabilities" => return lsp_actions::capabilities(ctx, &servers, &input).await,
        "request" => return lsp_actions::request(ctx, &servers, &input).await,
        _ => {},
    }
    let is_workspace = input.file.as_deref() == Some("*");
    if input.file.is_none() && action != "reload" { return ok("Error: file parameter required. Use `*` for workspace scope where supported."); }
    let resolved = input.file.as_deref().filter(|_| !is_workspace).map(|f| resolve_to_cwd(f, &ctx.root));
    if action == "symbols" && (is_workspace || resolved.is_none()) { return lsp_actions::workspace_symbols(ctx, &servers, &input).await; }
    if action == "reload" && (is_workspace || resolved.is_none()) { return lsp_actions::reload_workspace(ctx, &servers).await; }
    let Some(cfg) = resolved.as_deref().and_then(|f| lsp_config::server_for_file(&servers, f)) else { return ok("No language server found for this action") };
    *ctx.server.lock().unwrap_or_else(|e| e.into_inner()) = cfg.name.clone();
    if action == "reload" { ctx.pool.forget_failure(cfg, &ctx.root); }
    let file = resolved.expect("checked");
    let client = match ctx.pool.get(cfg, &ctx.root, None).await { Ok(c) => c, Err(e) => return ok(format!("LSP error: {e}")) };
    match file_action(ctx, &client, cfg, &file, &input, secs).await { Ok(t) => ok(t), Err(FileErr::Tool(e)) => Err(e), Err(FileErr::Lsp(e)) => ok(format!("LSP error: {e}")) }
}

enum FileErr { Tool(String), Lsp(String) }
impl From<String> for FileErr { fn from(e: String) -> Self { Self::Lsp(e) } }

async fn file_action(ctx: &Ctx, client: &Arc<Client>, cfg: &ServerConfig, file: &Path, input: &Input, secs: f64) -> Result<String, FileErr> {
    let action = input.action.as_str();
    let needs_index = PROJECT_INDEXED.contains(&action) && cfg.project_aware();
    let reconciled = client.reconcile_from_disk(file).await;
    if needs_index { client.wait_project_loaded(Duration::from_secs(15)).await; }
    if input.line.is_some() && input.symbol.is_none() && matches!(action, "references" | "rename" | "definition") && cfg.project_aware() {
        return Err(FileErr::Tool(format!("symbol is required for project-aware {action}; pass symbol=<name>, optionally symbol#N for repeated occurrences")));
    }
    let uri = file_to_uri(file);
    let line = input.line.map_or(1, |l| l.max(1.0) as usize);
    let character = resolve_symbol_column(file, line, input.symbol.as_deref())?;
    let position = json!({"line": line - 1, "character": character});
    let td = json!({"uri": uri});
    let root = &ctx.root;
    match action {
        "definition" | "type_definition" | "implementation" => {
            let (method, none, word) = match action { "definition" => ("textDocument/definition", "No definition found", "definition"), "type_definition" => ("textDocument/typeDefinition", "No type definition found", "type definition"), _ => ("textDocument/implementation", "No implementation found", "implementation") };
            let locs = fmt::locations(&client.request(method, json!({"textDocument": td, "position": position}), None).await?);
            if locs.is_empty() { return Ok(none.into()); }
            Ok(format!("Found {} {word}(s):\n{}", locs.len(), locs.iter().map(|l| fmt::format_location_with_context(l, root)).collect::<Vec<_>>().join("\n")))
        },
        "references" => {
            let mut result = Value::Null;
            for attempt in 0..=REFERENCES_RETRY {
                result = client.request("textDocument/references", json!({"textDocument": td, "position": position, "context": {"includeDeclaration": true}}), None).await?;
                let locs = result.as_array().cloned().unwrap_or_default();
                if !cfg.project_aware() || attempt == REFERENCES_RETRY { break; }
                if !locs.is_empty() && !only_queried_declaration(&locs, &uri, line - 1, character) { break; }
                client.wait_project_loaded(Duration::from_secs(15)).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let refs = result.as_array().cloned().unwrap_or_default();
            if refs.is_empty() { return Ok("No references found".into()); }
            let mut lines: Vec<String> = refs.iter().take(REFERENCE_CONTEXT_LIMIT).map(|l| fmt::format_location_with_context(l, root)).collect();
            if refs.len() > REFERENCE_CONTEXT_LIMIT {
                lines.push(format!("  ... {} additional reference(s) shown without context", refs.len() - REFERENCE_CONTEXT_LIMIT));
                lines.extend(refs[REFERENCE_CONTEXT_LIMIT..].iter().map(|l| format!("  {}", fmt::format_location(l, root))));
            }
            Ok(format!("Found {} reference(s):\n{}", refs.len(), lines.join("\n")))
        },
        "hover" => {
            let r = client.request("textDocument/hover", json!({"textDocument": td, "position": position}), None).await?;
            Ok(match r.get("contents") { Some(c) if !c.is_null() => fmt::hover_text(c), _ => "No hover information".into() })
        },
        "symbols" => {
            let r = client.request("textDocument/documentSymbol", json!({"textDocument": td}), None).await?;
            let items = r.as_array().cloned().unwrap_or_default();
            if items.is_empty() { return Ok("No symbols found".into()); }
            let rel = format_rel_cwd(file, root, false);
            let lines: Vec<String> = if items[0].get("selectionRange").is_some() {
                let mut out = Vec::new();
                for s in &items { fmt::document_symbol(s, 0, &mut out); }
                out
            } else { items.iter().map(|s| format!("{} {} @ line {}", fmt::symbol_icon(s["kind"].as_u64().unwrap_or(0)), s["name"].as_str().unwrap_or(""), s.pointer("/location/range/start/line").and_then(Value::as_u64).unwrap_or(0) + 1)).collect() };
            Ok(format!("Symbols in {rel}:\n{}", lines.join("\n")))
        },
        "rename" => {
            let Some(new_name) = input.new_name.as_deref().filter(|n| !n.is_empty()) else { return Ok("Error: new_name parameter required for rename".into()) };
            let r = client.request("textDocument/rename", json!({"textDocument": td, "position": position, "newName": new_name}), None).await?;
            if r.is_null() { return Ok("Rename returned no edits".into()); }
            if input.apply != Some(false) {
                let applied = apply_with_lsp(ctx, &r).await?;
                Ok(format!("Applied rename:\n{}", applied.iter().map(|a| format!("  {a}")).collect::<Vec<_>>().join("\n")))
            } else {
                Ok(format!("Rename preview:\n{}", fmt::workspace_edit_preview(&r, root).iter().map(|p| format!("  {p}")).collect::<Vec<_>>().join("\n")))
            }
        },
        "code_actions" => code_actions(ctx, client, cfg, &uri, &position, reconciled, input, secs).await.map_err(FileErr::Lsp),
        "reload" => lsp_actions::reload_one(client, cfg).await.map_err(FileErr::Lsp),
        _ => Ok(format!("Unknown action: {action}")),
    }
}

fn only_queried_declaration(locs: &[Value], uri: &str, line: usize, character: usize) -> bool {
    if locs.len() != 1 || locs[0]["uri"].as_str() != Some(uri) { return false; }
    let g = |p: &str, k: &str| locs[0].pointer(&format!("/range/{p}/{k}")).and_then(Value::as_u64).unwrap_or(0) as usize;
    (g("start", "line"), g("start", "character")) <= (line, character) && (line, character) <= (g("end", "line"), g("end", "character"))
}

/// Applies a workspace edit, then tells every live client about the changed / moved / deleted files.
pub async fn apply_with_lsp(ctx: &Ctx, edit: &Value) -> Result<Vec<String>, String> {
    let applied = lsp_edits::apply_workspace_edit_ops(edit, &ctx.root)?;
    for client in ctx.pool.clients().await {
        if client.cwd != ctx.root { continue; }
        for (old, _) in &applied.renamed { let u = file_to_uri(old); if client.open_files.lock().unwrap_or_else(|e| e.into_inner()).remove(&u).is_some() { client.notify("textDocument/didClose", json!({"textDocument": {"uri": u}})).await; } }
        for d in &applied.deleted { let u = file_to_uri(d); if client.open_files.lock().unwrap_or_else(|e| e.into_inner()).remove(&u).is_some() { client.notify("textDocument/didClose", json!({"textDocument": {"uri": u}})).await; } }
        for p in applied.changed.iter().chain(applied.created.iter()) { if client.open_files.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&file_to_uri(p)) { client.refresh_file(p).await; } }
        let mut changes: Vec<Value> = applied.created.iter().map(|p| json!({"uri": file_to_uri(p), "type": 1})).collect();
        changes.extend(applied.changed.iter().map(|p| json!({"uri": file_to_uri(p), "type": 2})));
        changes.extend(applied.deleted.iter().chain(applied.renamed.iter().map(|(o, _)| o)).map(|p| json!({"uri": file_to_uri(p), "type": 3})));
        if !changes.is_empty() { client.notify("workspace/didChangeWatchedFiles", json!({"changes": changes})).await; }
    }
    Ok(applied.summary)
}

#[allow(clippy::too_many_arguments)]
async fn code_actions(ctx: &Ctx, client: &Arc<Client>, cfg: &ServerConfig, uri: &str, position: &Value, reconciled: bool, input: &Input, secs: f64) -> Result<String, String> {
    let mut diagnostics: Vec<Value> = client.diagnostics.lock().unwrap_or_else(|e| e.into_inner()).get(uri).map(|p| p.diagnostics.clone()).unwrap_or_default();
    if reconciled {
        let cap = if cfg.project_aware() { 10.0 } else { 3.0_f64 }.min(secs);
        if let Ok(d) = client.wait_for_diagnostics(uri, Duration::from_secs_f64(cap), 0, client.document_version(uri)).await { diagnostics = d; }
    }
    let apply = input.apply == Some(true);
    let query = input.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let mut context = json!({"diagnostics": diagnostics, "triggerKind": 1});
    if !apply { if let Some(q) = query { context["only"] = json!([q]); } }
    let r = client.request("textDocument/codeAction", json!({"textDocument": {"uri": uri}, "range": {"start": position, "end": position}, "context": context}), None).await?;
    let actions = r.as_array().cloned().unwrap_or_default();
    if actions.is_empty() { return Ok("No code actions available".into()); }
    let listing = |a: &[Value]| a.iter().enumerate().map(|(i, x)| format!("  {}", fmt::code_action_line(x, i))).collect::<Vec<_>>().join("\n");
    if apply && input.query.is_some() {
        let Some(q) = query else { return Ok("Error: query parameter required when apply=true for code_actions".into()) };
        let selected = if q.bytes().all(|b| b.is_ascii_digit()) { q.parse::<usize>().ok().and_then(|i| actions.get(i)) } else { actions.iter().find(|a| a["title"].as_str().is_some_and(|t| t.to_lowercase().contains(&q.to_lowercase()))) };
        let Some(action) = selected else { return Ok(format!("No code action matches \"{q}\". Available actions:\n{}", listing(&actions))) };
        let title = action["title"].as_str().unwrap_or("").to_string();
        let (mut edits, mut commands) = (Vec::new(), Vec::new());
        if action.get("command").and_then(Value::as_str).is_some() {
            client.request("workspace/executeCommand", json!({"command": action["command"], "arguments": action.get("arguments").cloned().unwrap_or(json!([]))}), None).await?;
            commands.push(action["command"].as_str().unwrap_or("").to_string());
        } else {
            let mut resolved = action.clone();
            if resolved.get("edit").is_none() { if let Ok(r) = client.request("codeAction/resolve", action.clone(), None).await { resolved = r; } }
            if let Some(edit) = resolved.get("edit") { edits = apply_with_lsp(ctx, edit).await?; }
            if let Some(cmd) = resolved.get("command").filter(|c| c.is_object()) {
                client.request("workspace/executeCommand", json!({"command": cmd["command"], "arguments": cmd.get("arguments").cloned().unwrap_or(json!([]))}), None).await?;
                commands.push(cmd["command"].as_str().unwrap_or("").to_string());
            }
        }
        if edits.is_empty() && commands.is_empty() { return Ok(format!("Action \"{title}\" has no workspace edit or command to apply")); }
        let mut lines = Vec::new();
        if !edits.is_empty() { lines.push("  Workspace edit:".to_string()); lines.extend(edits.iter().map(|e| format!("    {e}"))); }
        if !commands.is_empty() { lines.push("  Executed command(s):".to_string()); lines.extend(commands.iter().map(|c| format!("    {c}"))); }
        return Ok(format!("Applied \"{title}\":\n{}", lines.join("\n")));
    }
    Ok(format!("{} code action(s):\n{}", actions.len(), listing(&actions)))
}
