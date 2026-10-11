//! Pi-compatible MCP coding tools implemented in native Rust.
//! Workspace is a working directory, not a sandbox: absolute paths are intentionally allowed.
use base64::{engine::general_purpose::STANDARD, Engine};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use rmcp::{handler::server::wrapper::Parameters, model::{CallToolResult, ContentBlock}, schemars::JsonSchema, tool, tool_router};
use serde::Deserialize;
use serde_json::json;
use std::{fs, process::Stdio, path::{Path,PathBuf}, time::{Duration,Instant}, sync::{Arc,Mutex,OnceLock}};
use tokio::{io::{AsyncRead, AsyncReadExt}, process::Command, sync::Semaphore, time::timeout};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GREP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GREP_FILES: usize = 20_000;
const MAX_OUTPUT_BYTES: usize = 50_000;

fn shorten_line(line: &str, max_bytes: usize) -> &str {
    if line.len() <= max_bytes { return line; }
    let mut end = max_bytes;
    while !line.is_char_boundary(end) { end -= 1; }
    &line[..end]
}

// A cancelled MCP request drops its tool future. Kill the whole Unix process
// group on cancellation rather than just the shell leader.
struct ShellGroupGuard(Option<u32>);
impl Drop for ShellGroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid)=self.0 {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
        }
    }
}

#[derive(Default)]
struct CapturedStream { data: Vec<u8>, truncated: bool }
async fn drain_stream<R: AsyncRead + Unpin>(mut stream: R, captured: Arc<Mutex<CapturedStream>>) {
    let mut chunk = [0u8; 8192];
    loop {
        let n = match stream.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(n) => n };
        let mut state = captured.lock().unwrap_or_else(|e| e.into_inner());
        let available = MAX_OUTPUT_BYTES.saturating_sub(state.data.len());
        state.data.extend_from_slice(&chunk[..n.min(available)]);
        if n > available { state.truncated = true; }
    }
}
fn shell_path() -> Option<std::ffi::OsString> {
    let original = std::env::var_os("PATH").unwrap_or_default();
    if !cfg!(target_os="macos") { return Some(original); }
    // GUI applications on macOS commonly inherit only /usr/bin:/bin:/usr/sbin:/sbin.
    // Preserve the user's existing order, then append conventional developer locations.
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

#[derive(Clone)]
pub struct CodingTools {root:PathBuf, process_limit: Arc<Semaphore>}
impl CodingTools {
    pub fn new(root:PathBuf)->Self {
        static PROCESS_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self { root, process_limit: Arc::clone(PROCESS_LIMIT.get_or_init(|| Arc::new(Semaphore::new(16)))) }
    }
    fn path(&self,p:&str)->PathBuf {let p=Path::new(p); if p.is_absolute(){p.to_path_buf()} else {self.root.join(p)}}
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
pub struct ReadArgs {/// Path to the file to read (relative or absolute)
    path:String, /// Line number to start reading from (1-indexed)
    offset:Option<usize>, /// Maximum number of lines to read
    limit:Option<usize>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct WriteArgs {/// File path
    path:String, /// New file content
    content:String}
#[derive(Debug,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct EditArgs {path:String, #[serde(default)] edits:Vec<Replacement>, #[serde(default)] old_text:Option<String>, #[serde(default)] new_text:Option<String>}
#[derive(Debug,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct Replacement {old_text:String,new_text:String}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct ShellArgs {command:String,timeout:Option<f64>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct LsArgs {path:Option<String>,limit:Option<usize>}
#[derive(Debug,Deserialize,JsonSchema)]
pub struct FindArgs {pattern:String,path:Option<String>,limit:Option<usize>}
#[derive(Debug,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct GrepArgs {pattern:String,path:Option<String>,glob:Option<String>,ignore_case:Option<bool>,literal:Option<bool>,context:Option<usize>,limit:Option<usize>}

#[tool_router(server_handler)]
impl CodingTools {
    #[tool(description = "Read a text file with optional line offset/limit; supports image files.")]
    fn read(&self,Parameters(args):Parameters<ReadArgs>)->CallToolResult {
        if args.offset==Some(0) {return err("offset must be 1-indexed");}
        let path=self.path(&args.path);
        if fs::metadata(&path).is_ok_and(|m| m.len()>MAX_FILE_BYTES) {
            return err(format!("File exceeds the 32 MiB read limit: {}",path.display()));
        }
        let data=match fs::read(&path){Ok(v)=>v,Err(e)=>return err(format!("Could not read {}: {e}",path.display()))};
        if data.len() as u64>MAX_FILE_BYTES {return err("File exceeds the 32 MiB read limit");}
        let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
        let image_mime=match ext.as_str(){"png"=>Some("image/png"),"jpg"|"jpeg"=>Some("image/jpeg"),"gif"=>Some("image/gif"),"webp"=>Some("image/webp"),"bmp"=>Some("image/bmp"),_=>None};
        if let Some(mime)=image_mime {
            let mut r=CallToolResult::success(vec![ContentBlock::image(STANDARD.encode(&data),mime)]);
            r.is_error=None;
            return r;
        }
        let text=match String::from_utf8(data){Ok(s)=>s,Err(_)=>return err("Binary file is not a supported image")};
        let start=args.offset.unwrap_or(1)-1;
        let limit=args.limit.unwrap_or(2_000);
        let mut lines=text.split_inclusive('\n').skip(start).take(limit).collect::<String>();
        if lines.len()>50_000 {lines=cut(lines)} 
        else if text.lines().count()>start+limit {lines.push_str("\n[More lines available; use offset.]");}
        ok(lines)
    }
    #[tool(description = "Write a UTF-8 file; creates parent directories when needed.")]
    fn write(&self,Parameters(args):Parameters<WriteArgs>)->CallToolResult {
        let path=self.path(&args.path);
        if args.content.len() as u64>MAX_FILE_BYTES {return err("Write exceeds the 32 MiB limit");}
        let result=(||->std::io::Result<()> {
            if let Some(dir)=path.parent(){fs::create_dir_all(dir)?;}
            fs::write(&path,args.content)?;
            Ok(())
        })();
        match result{Ok(())=>ok(format!("Wrote {}",path.display())),Err(e)=>err(format!("Could not write {}: {e}",path.display()))}
    }
    #[tool(description = "Edit a text file with unique exact-text replacements; all edits validate against the original file.")]
    fn edit(&self,Parameters(args):Parameters<EditArgs>)->CallToolResult {
        let path=self.path(&args.path);
        // Follow a file symlink instead of accidentally replacing the symlink itself.
        let path=match path.canonicalize(){
            Ok(path)=>path,
            Err(e)=>return err(format!("Could not resolve {}: {e}",path.display())),
        };
        if fs::metadata(&path).is_ok_and(|m|m.len()>MAX_FILE_BYTES){return err("Edit exceeds the 32 MiB file limit");}
        let original=match fs::read_to_string(&path){Ok(t)=>t,Err(e)=>return err(format!("Could not read {}: {e}",path.display()))};
        if original.len() as u64>MAX_FILE_BYTES{return err("Edit exceeds the 32 MiB file limit");}
        let mut edits=args.edits;
        if edits.is_empty(){
            if let (Some(old_text),Some(new_text))=(args.old_text,args.new_text){
                edits.push(Replacement{old_text,new_text});
            }
        }
        if edits.is_empty(){return err("edits must not be empty");}
        let mut spans=Vec::new();
        for edit in &edits {
            if edit.old_text.is_empty(){return err("oldText must not be empty");}
            let all=original.match_indices(&edit.old_text).collect::<Vec<_>>();
            if all.len()!=1 {return err(format!("oldText must match exactly once (found {}): {:?}",all.len(),edit.old_text.chars().take(60).collect::<String>()));}
            let start=all[0].0;spans.push((start,start+edit.old_text.len(),edit.new_text.as_str()));
        }
        spans.sort_by_key(|span|span.0);
        for pair in spans.windows(2){if pair[0].1>pair[1].0{return err("Edit ranges overlap");}}
        let mut result=String::with_capacity(original.len());
        let mut cursor=0;
        for (start,end,replacement) in spans{result.push_str(&original[cursor..start]);result.push_str(replacement);cursor=end;}
        result.push_str(&original[cursor..]);
        // Write to a sibling temp file, then rename. Do not truncate the original on an I/O error.
        let tmp=path.with_extension(format!("ailocalhub-{}.tmp",uuid::Uuid::new_v4()));
        let write=(||->std::io::Result<()> {
            let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
            use std::io::Write;
            let mut file=options.open(&tmp)?;
            file.set_permissions(fs::metadata(&path)?.permissions())?;
            file.write_all(result.as_bytes())?;
            file.sync_all()?;
            fs::rename(&tmp,&path)
        })();
        if let Err(e)=write {let _=fs::remove_file(&tmp);return err(format!("Could not edit {}: {e}",path.display()));}
        ok(format!("Edited {}",path.display()))
    }
    #[tool(description = "List files and directories; directories have a trailing slash.")]
    fn ls(&self,Parameters(args):Parameters<LsArgs>)->CallToolResult {
        let path=self.path(args.path.as_deref().unwrap_or("."));
        let dir=match fs::read_dir(&path){Ok(v)=>v,Err(e)=>return err(format!("Cannot list {}: {e}",path.display()))};
        let mut names=dir.filter_map(|e|e.ok()).map(|e|{
            let s=e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir(){format!("{s}/")}else{s}
        }).collect::<Vec<_>>();
        names.sort();
        ok(cut(names.into_iter().take(args.limit.unwrap_or(500).min(10_000)).collect::<Vec<_>>().join("\n")))
    }
    #[tool(description = "Find files by glob, honoring .gitignore; returns paths relative to the search directory.")]
    fn find(&self,Parameters(args):Parameters<FindArgs>)->CallToolResult {
        let root=self.path(args.path.as_deref().unwrap_or("."));
        if !root.is_dir(){return err(format!("Not a directory: {}",root.display()));}
        let pattern=match globset::Glob::new(&args.pattern){Ok(p)=>p.compile_matcher(),Err(e)=>return err(format!("Invalid glob: {e}"))};
        let mut result=Vec::new();
        for item in WalkBuilder::new(&root).hidden(false).build().flatten(){
            if item.path()==root {continue;}
            let rel=item.path().strip_prefix(&root).unwrap_or(item.path());
            let name=rel.file_name().unwrap_or_default();
            if pattern.is_match(rel)||pattern.is_match(name) {
                result.push(format!("{}{}",rel.display(),if item.file_type().map(|t|t.is_dir()).unwrap_or(false){"/"}else{""}));
                if result.len()>=args.limit.unwrap_or(1000).min(10_000){break;}
            }
        }
        result.sort();
        ok(cut(result.join("\n")))
    }
    #[tool(description = "Search file contents by regex or literal text; respects .gitignore.")]
    fn grep(&self,Parameters(args):Parameters<GrepArgs>)->CallToolResult {
        let root=self.path(args.path.as_deref().unwrap_or("."));
        let query=if args.literal.unwrap_or(false){regex::escape(&args.pattern)}else{args.pattern.clone()};
        let regex=match RegexBuilder::new(&query).case_insensitive(args.ignore_case.unwrap_or(false)).build(){
            Ok(r)=>r,Err(e)=>return err(format!("Invalid pattern: {e}"))};
        let glob=match args.glob.as_deref().map(globset::Glob::new).transpose() {
            Ok(v)=>v.map(|g|g.compile_matcher()),Err(e)=>return err(format!("Invalid glob: {e}"))};
        let mut output=String::new();
        let mut results=0usize;
        let limit=args.limit.unwrap_or(100).min(10_000);
        let walker = WalkBuilder::new(&root).hidden(false).build();
        let entries: Box<dyn Iterator<Item=PathBuf>> = if root.is_file() {
            Box::new(std::iter::once(root.clone()))
        } else {
            Box::new(walker.flatten().filter(|e|e.file_type().is_some_and(|t|t.is_file())).map(|e|e.into_path()))
        };
        let mut scanned_bytes=0u64;
        let mut scanned_files=0usize;
        'files: for path in entries {
            let rel=path.strip_prefix(&root).unwrap_or(&path);
            if let Some(g)=&glob {if !g.is_match(rel)&&!g.is_match(rel.file_name().unwrap_or_default()){continue;}}
            let size=match fs::metadata(&path){Ok(m)=>m.len(),Err(_)=>continue};
            if size>MAX_FILE_BYTES {continue;}
            if scanned_files>=MAX_GREP_FILES || scanned_bytes.saturating_add(size)>MAX_GREP_BYTES {break;}
            scanned_files+=1;
            scanned_bytes+=size;
            let data=match fs::read(&path){Ok(d)=>d,Err(_)=>continue};
            if data.len() as u64>MAX_FILE_BYTES {continue;}
            if data.iter().take(8192).any(|b|*b==0) {continue;}
            let text=String::from_utf8_lossy(&data);
            let lines=text.lines().collect::<Vec<_>>();
            for (idx,line) in lines.iter().enumerate(){
                if regex.is_match(line){
                    let c=args.context.unwrap_or(0).min(30);
                    for n in idx.saturating_sub(c)..=(idx+c).min(lines.len().saturating_sub(1)){
                        let trimmed=shorten_line(lines[n],4096);
                        let line=format!("{}:{}:{}: {}\n",path.display(),n+1,if n==idx{"match"}else{"context"},trimmed);
                        if output.len().saturating_add(line.len())>MAX_OUTPUT_BYTES {
                            output.push_str("[Search output truncated at 50 KB; narrow the query.]");
                            break 'files;
                        }
                        output.push_str(&line);
                        results+=1;
                        if results>=limit {break 'files;}
                    }
                }
            }
        }
        ok(output.trim_end_matches('\n').to_string())
    }
    #[tool(description = "Execute a shell command in the workspace; returns output, exit code, wall time and truncation status.")]
    async fn bash(&self,Parameters(args):Parameters<ShellArgs>)->CallToolResult {
        if args.command.trim().is_empty(){return err("command is required");}
        if let Some(seconds)=args.timeout {if !seconds.is_finite()||seconds<=0.0{return err("timeout must be positive");}}
        let _permit=match self.process_limit.clone().try_acquire_owned(){
            Ok(permit)=>permit,
            Err(_)=>return err("Process tool capacity reached (16 concurrent commands); retry later"),
        };
        let start=Instant::now();
        let mut command=if cfg!(windows){
            let mut c=Command::new("cmd");c.args(["/C",&args.command]);c
        }else{
            let mut c=Command::new("/bin/bash");c.args(["-c",&args.command]);c
        };
        command.current_dir(&self.root).kill_on_drop(true)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(path)=shell_path(){command.env("PATH",path);}
        #[cfg(unix)]
        {command.process_group(0);}
        let mut child=match command.spawn(){Ok(p)=>p,Err(e)=>return err(format!("Could not spawn shell: {e}"))};
        let pid=child.id();
        let mut group_guard=ShellGroupGuard(pid);
        let stdout=Arc::new(Mutex::new(CapturedStream::default()));
        let stderr=Arc::new(Mutex::new(CapturedStream::default()));
        let mut stdout_task=tokio::spawn(drain_stream(child.stdout.take().expect("stdout piped"),Arc::clone(&stdout)));
        let mut stderr_task=tokio::spawn(drain_stream(child.stderr.take().expect("stderr piped"),Arc::clone(&stderr)));
        let seconds=args.timeout.unwrap_or(3600.).min(86_400.);
        let result=timeout(Duration::from_secs_f64(seconds),child.wait()).await;
        let timed_out=result.is_err();
        if timed_out {
            #[cfg(unix)]
            if let Some(pid)=pid {unsafe{libc::kill(-(pid as i32),libc::SIGKILL);}}
            let _=child.start_kill();
            let _=timeout(Duration::from_secs(2),child.wait()).await;
        }
        group_guard.0=None;
        // Continue draining even if output exceeds the response cap, so a chatty child
        // cannot block forever on a full pipe. Bound the drain after process exit.
        if timeout(Duration::from_secs(2),async {
            let _=tokio::join!(&mut stdout_task,&mut stderr_task);
        }).await.is_err() {
            stdout_task.abort();
            stderr_task.abort();
        }
        let out=stdout.lock().unwrap_or_else(|e|e.into_inner());
        let err_out=stderr.lock().unwrap_or_else(|e|e.into_inner());
        let combined=format!("{}{}",String::from_utf8_lossy(&out.data),String::from_utf8_lossy(&err_out.data));
        let truncated=out.truncated||err_out.truncated||combined.len()>MAX_OUTPUT_BYTES;
        let mut output=cut(combined);
        if truncated && !output.contains("[Output truncated at 50 KB") {
            output.push_str("\n[Output truncated at 50 KB.]");
        }
        if timed_out {output.push_str(&format!("\nCommand timed out after {seconds}s"));}
        let code=match result {
            Ok(Ok(status))=>status.code(),
            _=>None,
        };
        let mut response=if timed_out||code!=Some(0){err(output.clone())}else{ok(output.clone())};
        response.structured_content=Some(json!({
            "output":output,
            "exit_code":code,
            "wall_time_seconds":start.elapsed().as_secs_f64(),
            "truncated":truncated,
            "timed_out":timed_out
        }));
        response
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
        assert_eq!(shorten_line("a😀b",2),"a");
    }
    #[test] fn file_size_caps_have_sane_bounds(){
        assert!(MAX_GREP_BYTES>=MAX_FILE_BYTES);
        assert!(MAX_OUTPUT_BYTES<MAX_FILE_BYTES as usize);
        assert_eq!(MAX_GREP_FILES,20_000);
    }
    #[test] fn process_limit_is_shared_by_sessions(){
        let a=CodingTools::new(PathBuf::from("/tmp"));
        let b=CodingTools::new(PathBuf::from("/tmp"));
        assert!(Arc::ptr_eq(&a.process_limit,&b.process_limit));
        assert_eq!(a.process_limit.available_permits(),16);
    }
    #[test] fn edit_checks_unique_and_overlap(){
        let d=std::env::temp_dir().join(format!("ai-local-hub-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();fs::write(d.join("x.txt"),"alpha beta gamma").unwrap();
        let tools=CodingTools::new(d.clone());
        let good=tools.edit(Parameters(EditArgs{path:"x.txt".into(),edits:vec![Replacement{old_text:"beta".into(),new_text:"B".into()}],old_text:None,new_text:None}));
        assert_ne!(good.is_error,Some(true));
        assert_eq!(fs::read_to_string(d.join("x.txt")).unwrap(),"alpha B gamma");
        let bad=tools.edit(Parameters(EditArgs{path:"x.txt".into(),edits:vec![Replacement{old_text:"missing".into(),new_text:"X".into()}],old_text:None,new_text:None}));
        assert_eq!(bad.is_error,Some(true));
        assert_eq!(fs::read_to_string(d.join("x.txt")).unwrap(),"alpha B gamma");
        let _=fs::remove_dir_all(d);
    }
}
