//! The `lsp` actions that are not a single position query: status, diagnostics, rename_file, capabilities, request, reload.
use super::{lsp_client::{file_to_uri, uri_to_file, Client}, lsp_config::{self, ServerConfig}, lsp_edits, lsp_format as fmt, lsp_position::resolve_symbol_column, lsp_tool::{Ctx, Input}, lsp_workspace, search_paths::{format_rel_cwd, resolve_to_cwd}, search_walk};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::Arc, time::Duration};

type Out = Result<String, String>;
fn ok(s: impl Into<String>) -> Out { Ok(s.into()) }
fn set_server(ctx: &Ctx, name: &str) { *ctx.server.lock().unwrap_or_else(|e| e.into_inner()) = name.to_string(); }

const MAX_GLOB_TARGETS: usize = 20;
const MAX_RENAME_PAIRS: usize = 1000;
const WORKSPACE_SYMBOL_LIMIT: usize = 200;

pub async fn status(ctx: &Ctx, servers: &[ServerConfig]) -> Out {
    if servers.is_empty() { return ok("No language servers configured for this project"); }
    let active = ctx.pool.active().await;
    let labelled: Vec<String> = servers.iter().map(|s| match active.iter().find(|(n, _)| *n == s.command) { Some((_, st)) => format!("{} ({st})", s.name), None => format!("{} (configured, not started)", s.name) }).collect();
    ok(format!("Language servers: {}\n  note: 'configured, not started' means the binary resolves on PATH but no request has spawned it yet; 'ready' means a client process is live for this cwd.", labelled.join(", ")))
}

fn dedupe_diagnostics(all: Vec<Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = all.into_iter().filter(|d| seen.insert(format!("{}:{}:{}:{}:{}", d.pointer("/range/start/line").unwrap_or(&Value::Null), d.pointer("/range/start/character").unwrap_or(&Value::Null), d.pointer("/range/end/line").unwrap_or(&Value::Null), d.pointer("/range/end/character").unwrap_or(&Value::Null), d.get("message").unwrap_or(&Value::Null)))).collect();
    fmt::sort_diagnostics(&mut out);
    out
}

pub async fn diagnostics(ctx: &Ctx, servers: &[ServerConfig], input: &Input, secs: f64) -> Out {
    let Some(file) = input.file.as_deref() else { return ok("Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.") };
    if file == "*" {
        let (description, output) = lsp_workspace::run(&ctx.root, Duration::from_secs_f64(secs)).await;
        return ok(format!("Workspace diagnostics ({description}):\n{output}"));
    }
    let (mut targets, mut truncated) = (vec![file.to_string()], false);
    if super::search_paths::has_glob(file) && !resolve_to_cwd(file, &ctx.root).is_file() {
        let found = search_walk::walk(&ctx.root, Some(file), search_walk::Opts { hidden: false, gitignore: false, include_dirs: false, bare_glob: false })?;
        truncated = found.len() > MAX_GLOB_TARGETS;
        targets = found.into_iter().take(MAX_GLOB_TARGETS).map(|e| e.rel).collect();
        if targets.is_empty() { return ok(format!("No files matched pattern: {file}")); }
    }
    let detailed = targets.len() > 1 || truncated;
    let mut results: Vec<String> = Vec::new();
    if truncated { results.push(format!("{} Pattern matched more than {MAX_GLOB_TARGETS} files; showing first {MAX_GLOB_TARGETS}. Narrow the glob or use workspace diagnostics.", fmt::ICON_WARN)); }
    let (mut attempts, mut successes) = (0usize, 0usize);
    for target in &targets {
        let resolved = resolve_to_cwd(target, &ctx.root);
        let for_file = lsp_config::servers_for_file(servers, &resolved);
        if for_file.is_empty() { results.push(format!("{} {target}: No language server found", fmt::ICON_ERR)); continue; }
        let uri = file_to_uri(&resolved);
        let rel = format_rel_cwd(&resolved, &ctx.root, false);
        let (mut all, mut failed, mut succeeded) = (Vec::new(), Vec::<String>::new(), 0usize);
        for cfg in for_file {
            attempts += 1;
            set_server(ctx, &cfg.name);
            let attempt: Result<Vec<Value>, String> = async {
                let client = ctx.pool.get(cfg, &ctx.root, None).await?;
                if cfg.project_aware() { client.wait_project_loaded(Duration::from_secs(15)).await; }
                let min = client.diag_version.load(std::sync::atomic::Ordering::SeqCst);
                client.refresh_file(&resolved).await;
                let expected = client.document_version(&uri);
                let cap = if detailed { 0.4 } else if cfg.project_aware() { 10.0 } else { 3.0 };
                client.wait_for_diagnostics(&uri, Duration::from_secs_f64(f64::min(cap, secs)), min, expected).await
            }.await;
            match attempt { Ok(d) => { all.extend(d); succeeded += 1; successes += 1; }, Err(_) => failed.push(cfg.name.clone()) }
        }
        let unique = dedupe_diagnostics(all);
        let formatted: Vec<String> = unique.iter().map(|d| fmt::format_diagnostic(d, &rel)).collect();
        if !detailed && targets.len() == 1 {
            if succeeded == 0 { return ok(format!("{} {rel}: all language servers failed ({})", fmt::ICON_ERR, failed.join(", "))); }
            if unique.is_empty() { return ok(if failed.is_empty() { "OK".to_string() } else { format!("OK\n{} some servers failed: {}", fmt::ICON_WARN, failed.join(", ")) }); }
            let mut out = format!("{}:\n{}", fmt::summary(&unique), fmt::group_messages(&formatted));
            if !failed.is_empty() { out.push_str(&format!("\n{} some servers failed: {}", fmt::ICON_WARN, failed.join(", "))); }
            return ok(out);
        }
        if unique.is_empty() {
            if succeeded == 0 { results.push(format!("{} {rel}: all language servers failed ({})", fmt::ICON_ERR, failed.join(", "))); }
            else { results.push(format!("{} {rel}: no issues", fmt::ICON_OK)); if !failed.is_empty() { results.push(format!("{} {rel}: some servers failed ({})", fmt::ICON_WARN, failed.join(", "))); } }
        } else {
            results.push(format!("{} {rel}: {}", fmt::ICON_ERR, fmt::summary(&unique)));
            results.push(fmt::group_messages(&formatted));
            if !failed.is_empty() { results.push(format!("{} {rel}: some servers failed ({})", fmt::ICON_WARN, failed.join(", "))); }
        }
    }
    let _ = (attempts, successes);
    ok(results.join("\n"))
}

pub async fn workspace_symbols(ctx: &Ctx, servers: &[ServerConfig], input: &Input) -> Out {
    let Some(q) = input.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) else { return ok("Error: query parameter required for workspace symbol search") };
    if servers.is_empty() { return ok("No language server found for this action"); }
    let (mut symbols, mut responded, mut failures) = (Vec::<Value>::new(), 0usize, Vec::<String>::new());
    let needle = q.to_lowercase();
    for cfg in servers {
        set_server(ctx, &cfg.name);
        match async { let c = ctx.pool.get(cfg, &ctx.root, None).await?; c.request("workspace/symbol", json!({"query": q}), None).await }.await {
            Ok(r) => { responded += 1; for s in r.as_array().cloned().unwrap_or_default() {
                let fields = [s["name"].as_str().unwrap_or("").to_string(), s["containerName"].as_str().unwrap_or("").to_string(), uri_to_file(s.pointer("/location/uri").and_then(Value::as_str).unwrap_or("")).to_string_lossy().into_owned()];
                if fields.iter().any(|f| f.to_lowercase().contains(&needle)) { symbols.push(s); }
            } },
            Err(e) => failures.push(format!("  {}: {}", cfg.name, e.replace('\t', " "))),
        }
    }
    let failure_section = if failures.is_empty() { String::new() } else { format!("\nServer failures:\n{}", failures.join("\n")) };
    if responded == 0 { return ok(format!("Workspace symbol search failed: all language servers failed{failure_section}")); }
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<Value> = symbols.into_iter().filter(|s| seen.insert(format!("{}:{}:{}:{}:{}:{}", s["name"], s["containerName"], s["kind"], s.pointer("/location/uri").unwrap_or(&Value::Null), s.pointer("/location/range/start/line").unwrap_or(&Value::Null), s.pointer("/location/range/start/character").unwrap_or(&Value::Null)))).collect();
    if unique.is_empty() { return ok(format!("No symbols matching \"{q}\"{failure_section}")); }
    let lines: Vec<String> = unique.iter().take(WORKSPACE_SYMBOL_LIMIT).map(|s| format!("  {}", fmt::symbol_information(s, &ctx.root))).collect();
    let more = if unique.len() > WORKSPACE_SYMBOL_LIMIT { format!("\n[…{} symbols elided…]", unique.len() - WORKSPACE_SYMBOL_LIMIT) } else { String::new() };
    ok(format!("Found {} symbol(s) matching \"{q}\":\n{}{more}{failure_section}", unique.len(), lines.join("\n")))
}

/// `rust-analyzer` has a real reload request; everything else gets `didChangeConfiguration` and a refresh of open files.
pub async fn reload_one(client: &Arc<Client>, cfg: &ServerConfig) -> Result<String, String> {
    if cfg.name == "rust-analyzer" || cfg.command == "rust-analyzer" {
        match client.request("rust-analyzer/reloadWorkspace", Value::Null, None).await { Ok(_) => return Ok(format!("Reloaded {}", cfg.name)), Err(e) if is_method_not_found(&e) => {}, Err(e) => return Err(e) }
    }
    client.notify("workspace/didChangeConfiguration", json!({"settings": cfg.settings.clone().unwrap_or_else(|| json!({}))})).await;
    if client.exited.load(std::sync::atomic::Ordering::SeqCst) { client.shutdown().await; return Ok(format!("Restarted {}", cfg.name)); }
    let open: Vec<String> = client.open_files.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
    for uri in open { client.refresh_file(&uri_to_file(&uri)).await; }
    Ok(format!("Reloaded {}", cfg.name))
}

fn is_method_not_found(msg: &str) -> bool { let m = msg.to_lowercase(); m.contains("method not found") || m.contains("unhandled method") || m.contains("not supported") || m.contains("-32601") }

pub async fn reload_workspace(ctx: &Ctx, servers: &[ServerConfig]) -> Out {
    let keep: Vec<String> = servers.iter().map(|s| s.key(&ctx.root)).collect();
    let stopped = ctx.pool.stop_stale(&keep).await;
    if servers.is_empty() { return ok("No language server found for this action"); }
    let mut out: Vec<String> = Vec::new();
    if !stopped.is_empty() { out.push(format!("Stopped {} server(s) with superseded configuration: {}", stopped.len(), stopped.join(", "))); }
    for cfg in servers {
        set_server(ctx, &cfg.name);
        ctx.pool.forget_failure(cfg, &ctx.root);
        match ctx.pool.get(cfg, &ctx.root, None).await { Ok(c) => out.push(reload_one(&c, cfg).await.unwrap_or_else(|e| format!("Failed to reload {}: {e}", cfg.name))), Err(e) => out.push(format!("Failed to reload {}: {e}", cfg.name)) }
    }
    ok(out.join("\n"))
}

pub async fn capabilities(ctx: &Ctx, servers: &[ServerConfig], input: &Input) -> Out {
    let list: Vec<&ServerConfig> = match input.file.as_deref().filter(|f| *f != "*") {
        Some(f) => { let l = lsp_config::servers_for_file(servers, &resolve_to_cwd(f, &ctx.root)); if l.is_empty() { return ok("No language server found for this file"); } l },
        None => servers.iter().collect(),
    };
    if list.is_empty() { return ok("No language servers configured"); }
    let mut sections = Vec::new();
    for cfg in list {
        set_server(ctx, &cfg.name);
        match ctx.pool.get(cfg, &ctx.root, None).await {
            Ok(c) => { let caps = c.capabilities.lock().unwrap_or_else(|e| e.into_inner()).clone(); let caps = if caps.is_null() { json!({}) } else { caps }; let pretty = serde_json::to_string_pretty(&caps).unwrap_or_default(); sections.push(format!("{}:\n  capabilities: {}", cfg.name, pretty.split('\n').collect::<Vec<_>>().join("\n  "))); },
            Err(e) => sections.push(format!("{}: failed to start ({e})", cfg.name)),
        }
    }
    ok(sections.join("\n"))
}

pub async fn request(ctx: &Ctx, servers: &[ServerConfig], input: &Input) -> Out {
    let Some(method) = input.query.as_deref().map(str::trim).filter(|m| !m.is_empty()) else { return ok("Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')") };
    let (cfg, target): (&ServerConfig, Option<PathBuf>) = match input.file.as_deref().filter(|f| *f != "*") {
        Some(f) => { let p = resolve_to_cwd(f, &ctx.root); match lsp_config::server_for_file(servers, &p) { Some(c) => (c, Some(p)), None => return ok("No language server found for this file") } },
        None => match servers.first() { Some(c) => (c, None), None => return ok("No language servers configured") },
    };
    set_server(ctx, &cfg.name);
    let params: Value = if let Some(payload) = &input.payload {
        match serde_json::from_str(payload) { Ok(v) => v, Err(e) => return ok(format!("Error: invalid JSON in payload: {e}")) }
    } else if let Some(t) = &target {
        let uri = file_to_uri(t);
        match input.line { Some(l) => { let col = resolve_symbol_column(t, l as usize, input.symbol.as_deref())?; json!({"textDocument": {"uri": uri}, "position": {"line": l as usize - 1, "character": col}}) }, None => json!({"textDocument": {"uri": uri}}) }
    } else { json!({}) };
    let result = async { let c = ctx.pool.get(cfg, &ctx.root, None).await?; if let Some(t) = &target { c.reconcile_from_disk(t).await; } c.request(method, params.clone(), None).await }.await;
    match result {
        Ok(r) => { let text = match &r { Value::Null => "null".to_string(), Value::String(s) => s.clone(), v => serde_json::to_string_pretty(v).unwrap_or_default() }; ok(format!("{} ← {method}:\n{text}", cfg.name)) },
        Err(e) => { let raw = params.to_string(); let preview = if raw.chars().count() > 400 { format!("{}...", raw.chars().take(397).collect::<String>()) } else { raw }; ok(format!("LSP error from {} on {method}: {e}\n  params: {preview}", cfg.name)) },
    }
}

fn rename_pairs(source: &Path, dest: &Path) -> Result<(Vec<(PathBuf, PathBuf)>, bool, bool), String> {
    if !source.is_dir() { return Ok((vec![(source.to_path_buf(), dest.to_path_buf())], false, false)); }
    let mut pairs = Vec::new();
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let ft = e.file_type().map_err(|e| e.to_string())?;
            if ft.is_dir() { stack.push(e.path()); } else if ft.is_file() {
                if pairs.len() >= MAX_RENAME_PAIRS { return Ok((pairs, true, true)); }
                let rel = e.path().strip_prefix(source).map(Path::to_path_buf).unwrap_or_default();
                pairs.push((e.path(), dest.join(rel)));
            }
        }
    }
    pairs.sort();
    Ok((pairs, true, false))
}

pub async fn rename_file(ctx: &Ctx, servers: &[ServerConfig], input: &Input) -> Out {
    let (Some(file), Some(new_name)) = (input.file.as_deref().filter(|f| !f.is_empty()), input.new_name.as_deref().filter(|f| !f.is_empty())) else { return ok("Error: rename_file requires both `file` (source path) and `new_name` (destination path)") };
    let (source, dest) = (resolve_to_cwd(file, &ctx.root), resolve_to_cwd(new_name, &ctx.root));
    if source == dest { return ok("Error: source and destination paths are identical"); }
    let rel = |p: &Path| format_rel_cwd(p, &ctx.root, false);
    if let Err(e) = std::fs::metadata(&source) { return ok(if e.kind() == std::io::ErrorKind::NotFound { format!("Error: source path does not exist: {}", rel(&source)) } else { format!("Error: cannot read source path {}: {}", rel(&source), e.kind()) }); }
    if dest.symlink_metadata().is_ok() { return ok(format!("Error: destination already exists: {}", rel(&dest))); }
    let (pairs, is_dir, exceeded) = rename_pairs(&source, &dest)?;
    if exceeded { return ok(format!("Error: directory contains more than {MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate")); }
    if pairs.is_empty() { return ok("Error: no files to rename"); }
    let files: Vec<Value> = pairs.iter().map(|(o, n)| json!({"oldUri": file_to_uri(o), "newUri": file_to_uri(n)})).collect();
    let params = json!({"files": files});
    let mut relevant: Vec<&ServerConfig> = Vec::new();
    let mut consider = |p: &Path| for s in lsp_config::servers_for_file(servers, p) { if !relevant.iter().any(|r| r.name == s.name) { relevant.push(s); } };
    consider(&source); consider(&dest);
    for (o, n) in &pairs { consider(o); consider(n); }
    let ordered: Vec<&ServerConfig> = servers.iter().filter(|s| relevant.iter().any(|r| r.name == s.name)).collect();
    let (mut responding, mut per_server, mut notes, mut hard) = (Vec::<String>::new(), Vec::<(&ServerConfig, Value)>::new(), Vec::<String>::new(), Vec::<String>::new());
    for cfg in &ordered {
        set_server(ctx, &cfg.name);
        let client = match ctx.pool.get(cfg, &ctx.root, None).await { Ok(c) => c, Err(e) => { notes.push(format!("  {}: {e}", cfg.name)); continue; } };
        if cfg.project_aware() { client.wait_project_loaded(Duration::from_secs(15)).await; }
        match client.request("workspace/willRenameFiles", params.clone(), None).await {
            Ok(r) => { responding.push(cfg.name.clone()); if r.get("changes").is_some() || r.get("documentChanges").is_some() { per_server.push((cfg, r)); } },
            Err(e) if is_method_not_found(&e) => {},
            Err(e) => { notes.push(format!("  {}: {e}", cfg.name)); hard.push(cfg.name.clone()); },
        }
    }
    let (source_label, dest_label) = (rel(&source), rel(&dest));
    let count_label = if is_dir { format!("{} file{} under {source_label}", pairs.len(), if pairs.len() != 1 { "s" } else { "" }) } else { source_label.clone() };
    if input.apply == Some(false) {
        let mut lines = vec![format!("Rename preview: {count_label} → {dest_label}")];
        if per_server.is_empty() { lines.push("  No LSP edits would be applied".into()); }
        for (cfg, edit) in &per_server { let e = fmt::workspace_edit_preview(edit, &ctx.root); if e.is_empty() { continue; } lines.push(format!("  {}:", cfg.name)); lines.extend(e.into_iter().map(|x| format!("    {x}"))); }
        if !notes.is_empty() { lines.push("  Server notes:".into()); lines.extend(notes); }
        return ok(lines.join("\n"));
    }
    if !hard.is_empty() {
        let mut lines = vec![format!("Error: aborted rename; workspace/willRenameFiles failed on {}, so semantic references would not be updated. No files were moved.", hard.join(", ")), "  Server notes:".to_string()];
        lines.extend(notes);
        return ok(lines.join("\n"));
    }
    // Coalesce edits per file: a project-aware server wins overlaps over a linter, otherwise the first server wins.
    struct Bucket { primary: String, primary_aware: bool, edits: Vec<Value>, discarded: usize, others: Vec<String> }
    let mut accepted: BTreeMap<PathBuf, Bucket> = BTreeMap::new();
    for (cfg, edit) in &per_server {
        let mut flat: BTreeMap<PathBuf, Vec<Value>> = BTreeMap::new();
        if let Some(Value::Object(ch)) = edit.get("changes") { for (u, e) in ch { flat.entry(uri_to_file(u)).or_default().extend(e.as_array().cloned().unwrap_or_default()); } }
        for c in edit.get("documentChanges").and_then(Value::as_array).into_iter().flatten() { if let (Some(u), Some(e)) = (c.pointer("/textDocument/uri").and_then(Value::as_str), c.get("edits").and_then(Value::as_array)) { flat.entry(uri_to_file(u)).or_default().extend(e.iter().cloned()); } }
        for (path, edits) in flat {
            let overlaps = |a: &Value, b: &Value| { let g = |v: &Value, p: &str| (v.pointer(&format!("/range/{p}/line")).and_then(Value::as_u64).unwrap_or(0), v.pointer(&format!("/range/{p}/character")).and_then(Value::as_u64).unwrap_or(0)); g(a, "start") < g(b, "end") && g(b, "start") < g(a, "end") };
            match accepted.get_mut(&path) {
                None => { accepted.insert(path, Bucket { primary: cfg.name.clone(), primary_aware: cfg.project_aware(), edits, discarded: 0, others: vec![] }); },
                Some(b) if cfg.project_aware() && !b.primary_aware => {
                    let (kept, dropped): (Vec<Value>, Vec<Value>) = b.edits.drain(..).partition(|oe| !edits.iter().any(|ne| overlaps(ne, oe)));
                    if !dropped.is_empty() { b.others.push(b.primary.clone()); }
                    b.discarded += dropped.len();
                    b.primary = cfg.name.clone(); b.primary_aware = true;
                    b.edits = edits.into_iter().chain(kept).collect();
                },
                Some(b) => { let mut dropped = 0; for ne in edits { if b.edits.iter().any(|ae| overlaps(ae, &ne)) { dropped += 1; } else { b.edits.push(ne); } } if dropped > 0 { b.others.push(cfg.name.clone()); b.discarded += dropped; } },
            }
        }
    }
    let mut summary: Vec<String> = Vec::new();
    let mut reference_edits: BTreeMap<PathBuf, Vec<Value>> = BTreeMap::new();
    for (path, b) in &accepted {
        summary.push(format!("  {}: applied {} edit(s) to {}", b.primary, b.edits.len(), rel(path)));
        if b.discarded > 0 { summary.push(format!("    note: discarded {} overlapping edit(s) from {} (kept {})", b.discarded, b.others.join(", "), b.primary)); }
        reference_edits.insert(path.clone(), b.edits.clone());
    }
    lsp_edits::apply_edits_then_rename(&reference_edits, &source, &dest)?;
    summary.push(format!("  Renamed {source_label} → {dest_label}"));
    for cfg in &ordered {
        let Ok(client) = ctx.pool.get(cfg, &ctx.root, None).await else { continue };
        for (old, _) in &pairs { let u = file_to_uri(old); if client.open_files.lock().unwrap_or_else(|e| e.into_inner()).remove(&u).is_some() { client.notify("textDocument/didClose", json!({"textDocument": {"uri": u}})).await; } }
        client.notify("workspace/didRenameFiles", params.clone()).await;
    }
    if !notes.is_empty() { summary.push("  Server notes:".into()); summary.extend(notes); }
    ok(format!("Renamed {count_label} → {dest_label}\n{}", summary.join("\n")))
}
