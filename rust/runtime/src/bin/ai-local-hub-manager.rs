use ai_local_hub_runtime::{manager_config,manager_core::RuntimeManager,manager_http};
use anyhow::{bail,Context,Result};
use rand::RngCore;
use serde::{Deserialize,Serialize};
use std::{env,fs,path::{Path,PathBuf},process::Command,sync::Arc,time::Duration};
use tokio::{io::AsyncReadExt,sync::Notify};
#[derive(Serialize,Deserialize)]
struct Lock{pid:u32,url:String,token:String}
fn parse_args()->Result<(bool,bool,bool,bool,bool,bool,u16,bool,Vec<String>)>{
    let args=env::args().skip(1).collect::<Vec<_>>();
    let mut local=false;let mut desktop=false;let mut headless=false;let mut reset=false;
    let mut open=true;let mut help=false;let mut port=4747;let mut strict=false;let mut names=Vec::new();
    let mut i=0;
    while i<args.len(){
        match args[i].as_str(){
            "--local-only"=>local=true,
            "--desktop"=>{desktop=true;port=0;open=false},
            "--headless"=>headless=true,
            "--reset"=>reset=true,
            "--no-open"=>open=false,
            "--help"|"-h"=>help=true,
            "--port"=>{i+=1;let s=args.get(i).context("--port requires number")?;port=s.parse().context("Port must be 0-65535")?;strict=true},
            "--instance"=>{i+=1;names.push(args.get(i).context("--instance requires name")?.to_lowercase())},
            other=>bail!("Unknown argument: {other}"),
        };i+=1;
    }
    Ok((local,desktop,headless,reset,open,help,port,strict,names))
}
fn token()->String{
    let mut bytes=[0u8;32];rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b|format!("{b:02x}")).collect()
}
fn resolve_binary()->Result<PathBuf>{
    if let Ok(s)=env::var("AI_LOCAL_HUB_RUNTIME_BIN"){return Ok(PathBuf::from(s));}
    let exe=env::current_exe()?;
    Ok(exe.with_file_name(if cfg!(windows){"ai-local-hub-runtime.exe"}else{"ai-local-hub-runtime"}))
}
fn resolve_web()->Result<PathBuf>{
    if let Ok(s)=env::var("AI_LOCAL_HUB_WEB_DIR"){return Ok(PathBuf::from(s));}
    let exe=env::current_exe()?;
    let beside=exe.parent().context("No executable directory")?.join("web");
    if beside.join("index.html").is_file(){return Ok(beside);}
    Ok(env::current_dir()?.join("dist/web"))
}
fn open_url(link:&str){
    let _=if cfg!(target_os="macos"){Command::new("open").arg(link).spawn()}
    else if cfg!(windows){Command::new("cmd").args(["/C","start","",link]).spawn()}
    else {Command::new("xdg-open").arg(link).spawn()};
}
fn read_lock(path:&Path)->Option<Lock>{
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
async fn acquire(path:&Path,ours:&Lock)->Result<Option<Lock>>{
    if let Some(parent)=path.parent(){fs::create_dir_all(parent)?;}
    for _ in 0..2{
        let mut file=match fs::OpenOptions::new().write(true).create_new(true).open(path){
            Ok(f)=>f,Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{
                if let Some(old)=read_lock(path) {
                    let client=reqwest::Client::builder().timeout(Duration::from_millis(1500)).build()?;
                    if client.get(&old.url).send().await.is_ok(){return Ok(Some(old));}
                }
                fs::remove_file(path).ok();continue;
            },
            Err(e)=>return Err(e.into())
        };
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;file.set_permissions(fs::Permissions::from_mode(0o600))?;}
        use std::io::Write;
        file.write_all(&serde_json::to_vec(ours)?)?;
        file.sync_all()?;
        return Ok(None);
    }
    bail!("Cannot acquire manager lock {}",path.display())
}
fn release(path:&Path,token:&str){
    if read_lock(path).is_some_and(|l|l.pid==std::process::id()&&l.token==token){let _=fs::remove_file(path);}
}
async fn run()->Result<()>{
    let (local,desktop,headless,reset,open,help,port,strict,names)=parse_args()?;
    if help{
        println!("AI Local Hub native Rust manager\n--port N, --desktop, --no-open, --local-only, --headless, --instance NAME, --reset");
        return Ok(());
    }
    let config_path=manager_config::config_path();
    if reset{let _=fs::remove_file(&config_path);println!("Removed {}",config_path.display());return Ok(());}
    let config=manager_config::load(&config_path)?;
    let manager=RuntimeManager::new(config_path.clone(),config,local,resolve_binary()?,env!("CARGO_PKG_VERSION").to_string());
    if !manager.runtime_bin.is_file(){bail!("Rust worker binary not found: {}",manager.runtime_bin.display());}
    if headless {
        let instances=manager.config.lock().await.instances.clone();
        for n in &names{if !instances.iter().any(|i|i.name.to_lowercase()==*n){bail!("Unknown instance: {n}");}}
        for inst in instances{if names.is_empty()||names.contains(&inst.name.to_lowercase()){manager.start(inst).await;}}
        let mut rx=manager.subscribe();
        let events=tokio::spawn(async move{
            while let Ok(event)=rx.recv().await{eprintln!("{event}");}
        });
        tokio::signal::ctrl_c().await?;
        manager.wait_stopped().await;
        events.abort();
        return Ok(());
    }
    let token=token();
    let shutdown=Arc::new(Notify::new());
    let (port,server)=manager_http::listen(Arc::clone(&manager),resolve_web()?,token.clone(),port,strict,Arc::clone(&shutdown)).await?;
    let url=format!("http://127.0.0.1:{port}/");
    let lock_path=config_path.parent().context("Invalid config path")?.join("manager.lock");
    let ours=Lock{pid:std::process::id(),url:url.clone(),token:token.clone()};
    if let Some(existing)=acquire(&lock_path,&ours).await?{
        let link=format!("{}?token={}",existing.url,existing.token);
        if desktop{println!("{}",serde_json::json!({"type":"ready","url":link,"owner":false}));}
        else {
            println!("AI Local Hub is already running.\nOpen: {link}");
            if open{open_url(&link);}
        }
        return Ok(());
    }
    let link=format!("{url}?token={token}");
    let handle=tokio::spawn(server);
    if desktop{
        println!("{}",serde_json::json!({"type":"ready","url":link,"owner":true}));
        let close=Arc::clone(&shutdown);
        tokio::spawn(async move{
            let mut stdin=tokio::io::stdin();
            let mut data=[0;1];
            loop{match stdin.read(&mut data).await{Ok(0)|Err(_)=>break,_=>{}}}
            close.notify_one();
        });
    }else{
        println!("AI Local Hub Rust manager running.\nOpen: {link}\nPress Ctrl+C to stop.");
        if open{open_url(&link);}
    }
    let cancel=Arc::clone(&shutdown);
    tokio::spawn(async move{let _=tokio::signal::ctrl_c().await;cancel.notify_one();});
    let outcome=handle.await?;
    manager.wait_stopped().await;
    release(&lock_path,&token);
    outcome
}
#[tokio::main]
async fn main(){
    if let Err(error)=run().await{
        eprintln!("[ai-local-hub-rust] {error:#}");
        std::process::exit(1);
    }
}
