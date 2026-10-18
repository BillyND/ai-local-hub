//! Pi-compatible MCP coding tools implemented in native Rust.
//! Workspace is a working directory, not a sandbox: absolute paths are intentionally allowed.
use pi_edit::EditStore;
use base64::{engine::general_purpose::STANDARD, Engine};
use rmcp::{handler::server::{router::tool::ToolRouter, wrapper::Parameters}, model::{CallToolResult, ContentBlock, InitializeRequestParams, InitializeResult}, schemars::JsonSchema, service::RequestContext, tool, tool_handler, tool_router, ErrorData, RoleServer, ServerHandler};
use serde::Deserialize;
use crate::tool_log::{brief,traced,traced_async};
use tokio_util::sync::CancellationToken;
mod artifacts;
mod ast_common;
mod ast_edit_tool;
mod ast_grep_tool;
mod bash_jobs;
mod bash_output;
mod bash_run;
mod bash_tool;
mod cancel;
mod display;
mod grep_engine;
mod grep_scope;
mod glob_tool;
mod grep_tool;
mod hashline_edit;
mod lsp_actions;
mod lsp_client;
mod lsp_config;
mod lsp_edits;
mod lsp_format;
mod lsp_pool;
mod lsp_position;
mod lsp_tool;
mod lsp_workspace;
mod process_group;
mod read_dir;
mod read_document;
mod read_selector;
mod read_text;
mod search_paths;
mod search_walk;
mod tool_groups;
mod tree_output;
mod write_file;
use serde_json::{json, Value};
use std::{fs, path::{Path,PathBuf}, sync::{Arc,LazyLock}, time::Duration};
pub use tool_groups::ToolGroups;
pub use read_document::{pdf_worker_main, PDF_WORKER_FLAG};
use tokio::sync::Semaphore;

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// A blocking tool call stops with an error past this, instead of scanning on after the client gave up.
const BLOCKING_BUDGET: Duration = Duration::from_secs(120);
/// Tree scans (grep, glob, ast_grep, ast_edit, resolve) running at once in this runtime; more calls queue
/// instead of competing for disk and CPU, so a burst of parallel searches cannot drag the machine down.
static SCANS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));
/// `wait` returns a still-running snapshot after this long (omp allows 30 min; MCP clients time out sooner).
const WAIT_CAP_SECS: u64 = 50;

fn shell_path() -> Option<std::ffi::OsString> {
    let original = std::env::var_os("PATH").unwrap_or_default();
    if !cfg!(target_os="macos") { return Some(original); }
    let mut paths = std::env::split_paths(&original).collect::<Vec<_>>();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".cargo/bin"));
        let target = if cfg!(target_arch="aarch64") { "stable-aarch64-apple-darwin" } else { "stable-x86_64-apple-darwin" };
        paths.push(home.join(".rustup/toolchains").join(target).join("bin"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin"));
    paths.push(PathBuf::from("/usr/local/bin"));
    std::env::join_paths(paths).ok()
}

/// Dropped with the last handle of an MCP session (closed or expired): its background jobs could no longer be
/// reached, waited for or cancelled, and each would hold a process slot forever, so they are stopped. Only
/// for handlers that served `initialize`: per-request handlers (protocol 2026-07-28) end after every call,
/// and their jobs keep running until the instance stops. The shared language servers exit once no
/// handler is left.
struct SessionEnd { jobs: Arc<bash_jobs::Jobs>, lsp: Arc<lsp_pool::Pool>, initialized: std::sync::atomic::AtomicBool }
impl Drop for SessionEnd {
    fn drop(&mut self) {
        if self.initialized.load(std::sync::atomic::Ordering::SeqCst) { self.jobs.cancel_all(); }
        self.lsp.session_ended();
    }
}

#[derive(Clone)]
pub struct CodingTools {root:PathBuf, groups:tool_groups::ToolGroups, process_limit: Arc<Semaphore>, store: EditStore, artifacts: Arc<artifacts::Artifacts>, jobs: Arc<bash_jobs::Jobs>, pending: Arc<ast_edit_tool::PendingList>, lsp: Arc<lsp_pool::Pool>, _session: Arc<SessionEnd>}
impl CodingTools {
    pub fn new(root:PathBuf)->Self { Self::with_groups(root, tool_groups::ToolGroups::default()) }
    pub fn from_env(root:PathBuf)->Result<Self,String> { Ok(Self::with_groups(root, tool_groups::ToolGroups::from_env()?)) }
    pub fn with_groups(root:PathBuf, groups:tool_groups::ToolGroups)->Self {
        static PROCESS_LIMIT: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(16)));
        let (jobs,lsp)=(Arc::new(bash_jobs::Jobs::default()),lsp_pool::Pool::shared());
        lsp.session_started();
        let session=Arc::new(SessionEnd{jobs:Arc::clone(&jobs),lsp:Arc::clone(&lsp),initialized:Default::default()});
        Self { root, groups, process_limit: Arc::clone(&PROCESS_LIMIT), store: EditStore::new(), artifacts: Arc::new(artifacts::Artifacts::new()), _session: session, jobs, pending: Arc::new(Default::default()), lsp }
    }
    /// Extract PDFs in child processes of `exe`, which must route `PDF_WORKER_FLAG` to `pdf_worker_main`.
    pub fn enable_pdf_worker(exe:PathBuf) { read_document::use_pdf_worker(exe) }
    /// Runtime shutdown: stops running tool bodies at their next check, asks language servers to exit, then
    /// stops every child process group still running.
    pub async fn shutdown_children() {
        cancel::begin_shutdown();
        let _ = tokio::time::timeout(Duration::from_secs(3), lsp_pool::Pool::shared().shutdown_all()).await;
        process_group::stop_all(Duration::from_secs(2)).await;
    }
    /// Runs a synchronous tool body on the blocking pool so it never stalls the async workers. `scan` bodies
    /// first take one of the shared scan slots. The client cancelling stops a body at its next check.
    async fn blocking(&self, tool:&'static str, detail:Value, cancel:CancellationToken, scan:bool, body:impl FnOnce(&CodingTools)->CallToolResult+Send+'static)->CallToolResult {
        let this=self.clone();
        let result=traced_async(tool,detail,async move {
            let _slot=if scan {
                tokio::select!{ slot=SCANS.acquire()=>slot.ok(), ()=cancel.cancelled()=>return err("Cancelled while waiting for a free search slot") }
            } else {None};
            cancel::run_blocking(cancel,BLOCKING_BUDGET,move||body(&this)).await.unwrap_or_else(err)
        }).await;
        self.deliver(result)
    }
    fn filtered_router(&self)->ToolRouter<Self> {
        let mut router=Self::all_tool_router();
        let enabled=self.groups.enabled_tools();
        for name in ["read","write","edit","grep","glob","bash","wait","kill_job","ast_grep","ast_edit","resolve","reject","lsp","ls"] {
            if !enabled.contains(name) { router.disable_route(name); }
        }
        router
    }
    pub fn tool_names()->Vec<String> { Self::new(PathBuf::from(".")).tool_names_for_instance() }
    pub fn tool_names_for_instance(&self)->Vec<String> { self.filtered_router().list_all().into_iter().map(|t|t.name.to_string()).collect() }
    fn path(&self,p:&str)->PathBuf {let p=Path::new(p); if p.is_absolute(){p.to_path_buf()} else {self.root.join(p)}}
    /// Appends settled background-job results to this tool's result (MCP has no server-initiated turns).
    fn deliver(&self,mut r:CallToolResult)->CallToolResult {
        if let Some(n)=self.jobs.take_notices(&|full|self.artifacts.save("bash",full.as_bytes())){r.content.push(ContentBlock::text(n));}
        r
    }
}
fn ok(text:impl Into<String>)->CallToolResult {
    let mut r=CallToolResult::success(vec![ContentBlock::text(text)]);
    r.is_error=None;
    r
}
fn err(message:impl Into<String>)->CallToolResult {CallToolResult::error(vec![ContentBlock::text(message)])}
fn cut(mut text:String)->String {
    if text.len()<=50_000 {return text}
    let mut end=50_000;
    while !text.is_char_boundary(end) {end-=1;}
    text.truncate(end);
    text.push_str("\n[Output truncated at 50 KB; use offset/limit or narrower search.]");
    text
}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct ReadArgs {/// Path to read. Line selectors go in the path: `file.rs:50-80`, `file.rs:-5`, `file.rs:raw`.
    path:String}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct WriteArgs {/// File path
    path:String, /// New file content
    content:Option<String>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct EditArgs {/// Hashline patch: `[PATH#TAG]` sections with PUT/CUT/REM/MV operations.
    input:String}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct BashArgs {/// Command to run
    command:String, /// Timeout in seconds; 0 disables the deadline; nonzero values are clamped to 1-3600 (default 300)
    timeout:Option<f64>, /// Working directory (use instead of `cd`)
    cwd:Option<String>, /// Run in a terminal; unavailable here, ignored with a notice
    pty:Option<bool>, /// Run as a background job and return its id immediately
    #[serde(rename="async")] background:Option<bool>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct AstGrepArgs {/// One ast-grep pattern (`$NAME` one node, `$$$NAME` zero or more)
    pat:String, /// File, directory or glob; `;`-separated list allowed (default `.`)
    path:Option<String>, /// Language override (alias), e.g. `cpp` for `.h`
    lang:Option<String>, /// Number of matches to skip, for pagination
    skip:Option<f64>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct AstEditOp {/// ast-grep pattern to match
    pat:String, /// Rewrite template; metavariables substitute; empty string deletes
    out:String}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct AstEditArgs {/// Rewrite operations (applied per language of each file)
    ops:Vec<AstEditOp>, /// Files, directories or globs to rewrite
    paths:Vec<String>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct ReasonArgs {/// One-sentence reason
    reason:Option<String>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct LspArgs {/// diagnostics | definition | type_definition | implementation | references | hover | symbols | rename | rename_file | code_actions | status | reload | capabilities | request
    action:String, /// File path (`*` for workspace scope where supported; a glob for diagnostics)
    file:Option<String>, /// 1-indexed line
    line:Option<f64>, /// Symbol on the line (substring; `name#N` for the Nth occurrence)
    symbol:Option<String>, /// Search query, code-action title or index, or raw LSP method for `request`
    query:Option<String>, /// New name for `rename`, or destination path for `rename_file`
    new_name:Option<String>, /// Apply the change (default true for rename / rename_file; false previews)
    apply:Option<bool>, /// Timeout in seconds (default 20, 5-300)
    timeout:Option<f64>, /// JSON params for `request`
    payload:Option<String>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct JobArgs {/// Job id such as `bg_1`
    id:String}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct LsArgs {path:Option<String>,limit:Option<usize>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct GlobArgs {/// Glob pattern or path list (`;`-separated), default `.`
    path:Option<String>, /// Include dotfiles (default true)
    hidden:Option<bool>, /// Respect gitignore (default true)
    gitignore:Option<bool>, /// Maximum results (default and max 200)
    limit:Option<f64>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct GrepArgs {/// Search pattern (regex)
    pattern:String, /// File, directory or glob to search; `;`-separated list allowed (default `.`)
    path:Option<String>, /// Case-sensitive match (default true)
    case:Option<bool>, /// Respect gitignore (default true)
    gitignore:Option<bool>, /// Number of files to skip, for pagination
    skip:Option<f64>}

#[tool_router(router = all_tool_router)]
impl CodingTools {
    #[tool(description = "Read a file, directory or image. PDF, DOCX, PPTX and XLSX files are returned as extracted text. Line selectors go in the path (`src/a.rs:50-80`, `:-5`, `:raw`). Text rows are `N:text` under a `[path#TAG]` snapshot header that `edit` anchors on.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn read(&self,Parameters(args):Parameters<ReadArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"path":args.path});
        self.blocking("read",detail,ct,false,move|t|t.read_impl(args)).await
    }
    fn read_impl(&self,args:ReadArgs)->CallToolResult {
        let (target,sel)=match read_selector::split(&args.path,|p|self.path(p)){Ok(v)=>v,Err(e)=>return err(e)};
        let artifact=target.strip_prefix("artifact://").map(|id|self.artifacts.path_for(id).ok_or_else(||format!("Artifact {id} not found")));
        let path=match artifact{Some(Ok(p))=>p,Some(Err(e))=>return err(e),None=>self.path(&target)};
        let meta=match fs::metadata(&path){Ok(m)=>m,Err(_)=>return err(format!("Path '{target}' not found"))};
        if meta.is_dir() {return ok(read_dir::list(&path));}
        if !meta.is_file() {return err(format!("Cannot read '{target}': it is not a regular file or directory."));}
        if meta.len()>MAX_FILE_BYTES {return err(format!("File exceeds the 32 MiB read limit: {}",path.display()));}
        let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
        // Extraction may stop early, but must produce more than `cut` keeps so the truncation notice shows.
        if let Some(doc)=read_document::extract(&ext,&path,64*1024) {
            return match doc {Ok(t)=>ok(cut(t)),Err(e)=>err(format!("Cannot extract text from '{target}': {e}"))};
        }
        let data=match fs::read(&path){Ok(v)=>v,Err(e)=>return err(format!("Could not read {}: {e}",path.display()))};
        let image_mime=match ext.as_str(){"png"=>Some("image/png"),"jpg"|"jpeg"=>Some("image/jpeg"),"gif"=>Some("image/gif"),"webp"=>Some("image/webp"),"bmp"=>Some("image/bmp"),_=>None};
        if let Some(mime)=image_mime {
            let mut r=CallToolResult::success(vec![ContentBlock::image(STANDARD.encode(&data),mime)]);
            r.is_error=None;
            return r;
        }
        let display=if target.starts_with("artifact://"){target.clone()}else{display::display_path(&self.root,&path)};
        let binary_note=format!("[Cannot read binary file '{display}' ({} bytes); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]",data.len());
        if data.iter().take(8192).any(|b|*b==0) {return err(binary_note);}
        let text=match String::from_utf8(data){Ok(s)=>s,Err(_)=>return err(binary_note)};
        match read_text::render(&display,&path,&text,&sel,&self.store){Ok(out)=>ok(out),Err(e)=>err(e)}
    }
    #[tool(description = "Write a whole file (creates parent directories). Prefer `edit` for existing files. Returns the new `[path#TAG]` snapshot header.", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false))]
    async fn write(&self,Parameters(args):Parameters<WriteArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"path":args.path,"bytes":args.content.as_ref().map(|c|c.len())});
        self.blocking("write",detail,ct,false,move|t|match write_file::run(&t.root,&t.store,&args.path,args.content){Ok(t)=>ok(t),Err(e)=>err(e)}).await
    }
    #[tool(description = pi_edit::description(pi_edit::EditMode::Hashline), annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false))]
    async fn edit(&self,Parameters(args):Parameters<EditArgs>)->CallToolResult {
        let detail=json!({"bytes":args.input.len()});
        let result=traced_async("edit",detail,async {
            match hashline_edit::apply(&self.root,&self.store,&args.input).await{Ok(t)=>ok(t),Err(e)=>err(e)}
        }).await;
        self.deliver(result)
    }
    #[tool(description = "List files and directories; directories have a trailing slash.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn ls(&self,Parameters(args):Parameters<LsArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"path":args.path,"limit":args.limit});
        self.blocking("ls",detail,ct,false,move|t|t.ls_impl(args)).await
    }
    fn ls_impl(&self,args:LsArgs)->CallToolResult {
        let path=self.path(args.path.as_deref().unwrap_or("."));
        let dir=match fs::read_dir(&path){Ok(v)=>v,Err(e)=>return err(format!("Cannot list {}: {e}",path.display()))};
        let mut names=dir.filter_map(|e|e.ok()).map(|e|{
            let s=e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir(){format!("{s}/")}else{s}
        }).collect::<Vec<_>>();
        names.sort();
        ok(cut(names.into_iter().take(args.limit.unwrap_or(500).min(10_000)).collect::<Vec<_>>().join("\n")))
    }
    #[tool(description = "Glob files/dirs: `;`-separated paths or patterns, default workspace root. `gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Newest-first; dirs end `/`.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn glob(&self,Parameters(args):Parameters<GlobArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"path":args.path,"limit":args.limit});
        self.blocking("glob",detail,ct,true,move|t|match glob_tool::run(&t.root,glob_tool::Input{path:args.path,hidden:args.hidden,gitignore:args.gitignore,limit:args.limit}){Ok(t)=>ok(t),Err(e)=>err(e)}).await
    }
    #[tool(description = "Search file contents by regex (Rust, then look-around capable engine). `path`: `;`-separated file/dir/glob list, default `.`; a bare glob like `*.ts` matches at any depth, `dir/*.ts` only direct children. File-only selector: `src/foo.ts:50-100`. Default case-sensitive, gitignore respected; `skip` paginates files (20 per page). Results are `*N:text` rows under `[path#TAG]` / `## file#TAG` headers that `edit` can anchor on.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn grep(&self,Parameters(args):Parameters<GrepArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"pattern":brief(&args.pattern),"path":args.path});
        self.blocking("grep",detail,ct,true,move|t|{
            let input=grep_tool::Input{pattern:args.pattern,path:args.path,case:args.case,gitignore:args.gitignore,skip:args.skip};
            match grep_tool::run(&t.root,&t.store,input){Ok(t)=>ok(t),Err(e)=>err(e)}
        }).await
    }
    #[tool(description = "Run a shell command (bash -c; each call is a fresh shell). Use `cwd`, not `cd`. `async` defers finite results but keeps the deadline (default 300s); `timeout: 0` for watchers and long jobs. Output is head+tail truncated; the full result is at `artifact://<id>` (read it with `read`). Non-pty calls still running after 60s (or 1s before `timeout`, if sooner) move to background job `bg_N` and keep running to `timeout`; the result is appended to your next tool result, or call `wait`. NEVER poll.", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = true))]
    async fn bash(&self,Parameters(args):Parameters<BashArgs>)->CallToolResult {
        let detail=json!({"command":brief(&args.command),"timeout":args.timeout,"cwd":args.cwd});
        let permit=match self.process_limit.clone().try_acquire_owned(){
            Ok(p)=>p,
            Err(_)=>return self.deliver(err("Process tool capacity reached (16 concurrent commands); retry later")),
        };
        let ctx=bash_tool::Ctx{root:self.root.clone(),artifacts:Arc::clone(&self.artifacts),jobs:Arc::clone(&self.jobs),permit};
        let input=bash_tool::Input{command:args.command,timeout:args.timeout,cwd:args.cwd,pty:args.pty,background:args.background};
        let result=traced_async("bash",detail,async move{let (text,failed)=bash_tool::run(ctx,input).await;if failed{err(text)}else{ok(text)}}).await;
        self.deliver(result)
    }
    #[tool(description = "Structural code search via ast-grep: use when syntax shape matters more than text (calls, declarations). Narrow each call to one language; `pat` is ONE AST pattern (`$NAME` = one node, `$_` unbound, `$$$NAME` zero-or-more; a repeated metavariable must match identical code). Patterns must parse as a single AST node (wrap fragments, e.g. `class $_ { ... }`). Parse issues mean query failure, not absence. Results are `*N:text` rows (+ `meta:` captures) under `[path#TAG]` headers; 50 matches per page, use `skip`.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn ast_grep(&self,Parameters(args):Parameters<AstGrepArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"pat":brief(&args.pat),"path":args.path,"lang":args.lang});
        self.blocking("ast_grep",detail,ct,true,move|t|match ast_grep_tool::run(&t.root,&t.store,ast_grep_tool::Input{pat:args.pat,path:args.path,lang:args.lang,skip:args.skip}){Ok(t)=>ok(t),Err(e)=>err(e)}).await
    }
    #[tool(description = "Structural AST-aware rewrites via ast-grep, for codemods where text replace is unsafe. Mixed-language paths are fine: each file is parsed in its own language. Metavariables in `pat` (`$A`, `$$$ARGS`) substitute into `out`; delete with empty `out`. Patterns match AST structure, not text; a repeated metavariable must match identical code; rewrite patterns must parse as a single AST node. Matches are STAGED as a proposal, not applied: finalize with `resolve` (apply) or `reject` (discard). Parse issues mean a malformed rewrite, not a clean no-op. For one-off text edits prefer `edit`.", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false))]
    async fn ast_edit(&self,Parameters(args):Parameters<AstEditArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"ops":args.ops.len(),"paths":args.paths});
        let input=ast_edit_tool::Input{ops:args.ops.into_iter().map(|o|ast_edit_tool::Op{pat:o.pat,out:o.out}).collect(),paths:args.paths};
        self.blocking("ast_edit",detail,ct,true,move|t|match ast_edit_tool::run(&t.root,&t.store,&t.pending,input){Ok(t)=>ok(t),Err(e)=>err(e)}).await
    }
    #[tool(description = "Apply the oldest staged `ast_edit` preview (write a one-sentence reason). Only valid while a preview is pending.", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false))]
    async fn resolve(&self,Parameters(_args):Parameters<ReasonArgs>,ct:CancellationToken)->CallToolResult {
        self.blocking("resolve",json!({}),ct,true,|t|match ast_edit_tool::resolve(&t.root,&t.store,&t.pending){Ok((t,stale))=>if stale{err(t)}else{ok(t)},Err(e)=>err(e)}).await
    }
    #[tool(description = "Discard the oldest staged `ast_edit` preview without changing any file (write a one-sentence reason).", annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    fn reject(&self,Parameters(args):Parameters<ReasonArgs>)->CallToolResult {
        self.deliver(traced("reject",json!({}),||ok(ast_edit_tool::reject(&self.pending,args.reason.as_deref().unwrap_or("")))))
    }
    #[tool(description = "Symbol-aware code intelligence from language servers: navigation, refactors and diagnostics where text tools miss callsites. Position-based actions take `file` + `line` + `symbol` (substring; `#N` for the Nth match; `line` is 1-indexed). `rename` applies by default (`apply: false` previews); project-aware lookups ERROR without `symbol`. `code_actions` lists by default; apply ONE with `apply: true` + `query` (title substring or index). `rename_file` moves a file AND rewrites all imports/references. `diagnostics` takes a path, a glob, or `file: \"*\"` for the workspace. `symbols`: `file` lists file symbols, `file: \"*\"` + `query` searches the workspace. `reload` restarts/reloads one server (`file`) or all (`*`). `request`: raw LSP, `query` = method, `payload` = JSON params. Symbol-aware work MUST use `lsp` whenever a server is available; NEVER do a cross-file rename with `ast_edit`/`sed`/hand edits when `rename`/`rename_file` can.", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false))]
    async fn lsp(&self,Parameters(args):Parameters<LspArgs>,ct:CancellationToken)->CallToolResult {
        let detail=json!({"action":args.action,"file":args.file});
        let ctx=lsp_tool::Ctx{root:self.root.clone(),pool:Arc::clone(&self.lsp),server:Default::default(),cancel:ct};
        let input=lsp_tool::Input{action:args.action,file:args.file,line:args.line,symbol:args.symbol,query:args.query,new_name:args.new_name,apply:args.apply,timeout:args.timeout,payload:args.payload};
        let result=traced_async("lsp",detail,async move{match lsp_tool::run(&ctx,input).await{Ok(t)=>ok(t),Err(e)=>err(e)}}).await;
        self.deliver(result)
    }
    #[tool(description = "Wait only when blocked with nothing else to do. Blocks on background jobs you started; returns on the first result (or a still-running snapshot after a safety cap). Nothing running: errors. Results also arrive with your next tool result. NEVER poll while work remains.", annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn wait(&self,ct:CancellationToken)->CallToolResult {
        tokio::select!{
            r=self.jobs.wait(Duration::from_secs(WAIT_CAP_SECS))=>match r{Ok(t)=>ok(t),Err(e)=>err(e)},
            ()=ct.cancelled()=>err("wait was cancelled"),
        }
    }
    #[tool(description = "Cancel a running background job by id (`bg_1`).", annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false))]
    fn kill_job(&self,Parameters(args):Parameters<JobArgs>)->CallToolResult {
        ok(self.jobs.cancel(&args.id))
    }
}
#[tool_handler(router = self.filtered_router())]
impl ServerHandler for CodingTools {
    /// The default handshake, plus marking this handler as owning a session.
    async fn initialize(&self, request:InitializeRequestParams, context:RequestContext<RoleServer>)->Result<InitializeResult,ErrorData> {
        self._session.initialized.store(true,std::sync::atomic::Ordering::SeqCst);
        context.peer.set_peer_info(request.clone());
        self.negotiate_initialize(&request)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn unicode_truncation_never_splits_a_character(){
        let s=format!("{}😀 after", "a".repeat(49_999));
        let cut=cut(s);
        assert!(cut.ends_with("[Output truncated at 50 KB; use offset/limit or narrower search.]"));
        assert!(cut.starts_with(&"a".repeat(49_999)));
    }
    #[test] fn tools_declare_accurate_annotations(){
        let tools=CodingTools::new(PathBuf::from(".")).filtered_router().list_all();
        let ann=|n:&str|tools.iter().find(|t|t.name==n).and_then(|t|t.annotations.clone()).unwrap_or_else(||panic!("{n} has no annotations"));
        for n in ["read","grep","glob","ls","ast_grep","wait"]{let a=ann(n);assert_eq!((a.read_only_hint,a.destructive_hint),(Some(true),Some(false)),"{n}");}
        for n in ["write","edit","ast_edit","resolve","bash","kill_job","lsp"]{let a=ann(n);assert_eq!((a.read_only_hint,a.destructive_hint),(Some(false),Some(true)),"{n}");}
        assert_eq!(ann("bash").open_world_hint,Some(true));
        assert_eq!(ann("read").open_world_hint,Some(false));
    }
    #[test] fn startup_log_lists_every_served_tool(){
        let names=CodingTools::tool_names();
        assert_eq!(names.len(),14);
        for n in ["read","write","edit","glob","grep","bash","wait","kill_job","ast_grep","ast_edit","resolve","reject","lsp","ls"]{assert!(names.iter().any(|x|x==n),"{n}");}
    }
    #[test] fn core_group_hides_optional_tools(){
        let groups=tool_groups::ToolGroups::from_names(["core"]).unwrap();
        let names=CodingTools::with_groups(PathBuf::from("/tmp"),groups).tool_names_for_instance();
        assert_eq!(names, vec!["bash","edit","glob","grep","kill_job","read","wait","write"]);
    }
    #[test] fn process_limit_and_language_servers_are_shared_by_sessions(){
        let a=CodingTools::new(PathBuf::from("/tmp"));
        let b=CodingTools::new(PathBuf::from("/tmp"));
        assert!(Arc::ptr_eq(&a.process_limit,&b.process_limit));
        assert!(Arc::ptr_eq(&a.lsp,&b.lsp));
        assert_eq!(a.process_limit.available_permits(),16);
    }
    #[test] fn ending_a_session_cancels_its_background_jobs(){
        let tools=CodingTools::new(PathBuf::from("/tmp"));
        tools._session.initialized.store(true,std::sync::atomic::Ordering::SeqCst);
        let (tx,rx)=tokio::sync::watch::channel(false);
        let jobs=Arc::clone(&tools.jobs);
        jobs.register("watcher",tx).unwrap();
        let other_handle=tools.clone();
        drop(tools);
        assert!(!*rx.borrow(),"a live handle keeps the session open");
        drop(other_handle);
        assert!(*rx.borrow());
        // A per-request handler (never initialized) leaves its jobs running.
        let stateless=CodingTools::new(PathBuf::from("/tmp"));
        let (tx,rx)=tokio::sync::watch::channel(false);
        stateless.jobs.register("dev server",tx).unwrap();
        drop(stateless);
        assert!(!*rx.borrow());
    }
}
