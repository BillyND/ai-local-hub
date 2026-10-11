use crate::{manager_config::{self,InstanceConfig,StoredConfig},tunnel_download};
use anyhow::{Context,Result};
use serde::Serialize;
use serde_json::{json,Value};
use std::{collections::{HashMap,VecDeque},path::PathBuf,sync::Arc,time::Duration};
use tokio::{io::{AsyncBufReadExt,BufReader},process::Command,sync::{broadcast,Mutex,oneshot},time::timeout};
#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {
    pub state:String,
    #[serde(skip_serializing_if="Option::is_none")]pub phase:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]pub url:Option<String>,
    pub tunnel_ready:bool,
    #[serde(skip_serializing_if="Option::is_none")]pub error:Option<String>,
}
impl Status {
    fn stopped()->Self{Self{state:"stopped".into(),phase:None,url:None,tunnel_ready:false,error:None}}
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct InstanceView<'a>{
    id:&'a str,name:&'a str,workspace_root:&'a str,tunnel_id:&'a str,has_api_key:bool,tool_groups:&'a [String],status:Status
}
struct Entry{status:Status,logs:VecDeque<String>,generation:u64,stop:Option<oneshot::Sender<()>>,active_worker:bool}
impl Default for Entry {
    fn default()->Self{Self{status:Status::stopped(),logs:VecDeque::new(),generation:0,stop:None,active_worker:false}}
}
pub struct RuntimeManager{
    pub config_path:PathBuf,
    pub config:Mutex<StoredConfig>,
    pub local_only:bool,
    pub cache_dir:PathBuf,
    pub runtime_bin:PathBuf,
    pub version:String,
    entries:Mutex<HashMap<String,Entry>>,
    events:broadcast::Sender<String>,
    tunnel_path:Mutex<Option<PathBuf>>,
}
impl RuntimeManager{
    pub fn new(config_path:PathBuf,config:StoredConfig,local_only:bool,runtime_bin:PathBuf,version:String)->Arc<Self>{
        let (events,_)=broadcast::channel(2_048);
        Arc::new(Self{cache_dir:manager_config::cache_dir(&config),config_path,config:Mutex::new(config),local_only,runtime_bin,version,entries:Mutex::new(HashMap::new()),events,tunnel_path:Mutex::new(None)})
    }
    pub fn subscribe(&self)->broadcast::Receiver<String>{self.events.subscribe()}
    pub fn broadcast(&self,event:Value){let _=self.events.send(event.to_string());}
    pub async fn view(&self,config:&InstanceConfig)->Value{
        let entries=self.entries.lock().await;
        let status=entries.get(&config.id).map(|e|e.status.clone()).unwrap_or_else(Status::stopped);
        serde_json::to_value(InstanceView{id:&config.id,name:&config.name,workspace_root:&config.workspace_root,tunnel_id:&config.tunnel_id,has_api_key:true,tool_groups:&config.tool_groups,status}).unwrap()
    }
    pub async fn views(&self)->Vec<Value>{
        let configs=self.config.lock().await.instances.clone();
        let entries=self.entries.lock().await;
        configs.iter().map(|c|{
            let status=entries.get(&c.id).map(|e|e.status.clone()).unwrap_or_else(Status::stopped);
            json!({"id":c.id,"name":c.name,"workspaceRoot":c.workspace_root,"tunnelId":c.tunnel_id,"hasApiKey":true,"toolGroups":c.tool_groups,"status":status})
        }).collect()
    }
    pub async fn announce(&self){self.broadcast(json!({"type":"instances","instances":self.views().await}));}
    pub async fn lines(&self,id:&str)->Vec<String>{
        self.entries.lock().await.get(id).map(|e|e.logs.iter().cloned().collect()).unwrap_or_default()
    }
    pub async fn get_instance(&self,id:&str)->Option<InstanceConfig>{
        self.config.lock().await.instances.iter().find(|c|c.id==id).cloned()
    }
    pub async fn save(&self)->Result<()>{
        let config=self.config.lock().await;
        manager_config::save(&self.config_path,&config)
    }
    async fn status(&self,id:&str,gen:u64,status:Status){
        let mut entries=self.entries.lock().await;
        let entry=entries.entry(id.to_string()).or_default();
        if entry.generation!=gen{return;}
        entry.status=status.clone();
        drop(entries);
        self.broadcast(json!({"type":"status","id":id,"status":status}));
    }
    async fn phase(&self,id:&str,gen:u64,msg:String){
        let mut entries=self.entries.lock().await;
        let entry=entries.entry(id.to_string()).or_default();
        if entry.generation!=gen{return;}
        entry.status.phase=Some(msg);
        let status=entry.status.clone();
        drop(entries);
        self.broadcast(json!({"type":"status","id":id,"status":status}));
    }
    async fn log(&self,inst:&InstanceConfig,message:String){
        let msg=if inst.api_key.is_empty(){message}else{message.replace(&inst.api_key,"[REDACTED]")};
        let mut entries=self.entries.lock().await;
        let entry=entries.entry(inst.id.clone()).or_default();
        entry.logs.push_back(msg.clone());
        while entry.logs.len()>1_000{entry.logs.pop_front();}
        drop(entries);
        self.broadcast(json!({"type":"log","id":inst.id,"line":msg}));
    }
    pub async fn start(self:&Arc<Self>,inst:InstanceConfig){
        let gen={
            let mut entries=self.entries.lock().await;
            let entry=entries.entry(inst.id.clone()).or_default();
            if !["stopped","error"].contains(&entry.status.state.as_str()){return;}
            if entry.stop.is_some(){return;}
            entry.generation+=1;
            entry.status=Status{state:"starting".into(),phase:Some("Starting worker".into()),url:None,tunnel_ready:false,error:None};
            entry.logs.clear();
            let status=entry.status.clone();
            self.broadcast(json!({"type":"status","id":inst.id,"status":status}));
            entry.generation
        };
        let manager=Arc::clone(self);
        tokio::spawn(async move{
            if let Err(error)=manager.run_worker(inst.clone(),gen).await {
                manager.status(&inst.id,gen,Status{state:"error".into(),phase:None,url:None,tunnel_ready:false,error:Some(format!("{error:#}").replace(&inst.api_key,"[REDACTED]"))}).await;
            }
        });
    }
    async fn resolve_tunnel(&self)->Result<PathBuf>{
        let mut guard=self.tunnel_path.lock().await;
        if let Some(path)=guard.as_ref(){return Ok(path.clone());}
        if let Ok(path)=std::env::var("WORKSPACE_TOOLS_TUNNEL_BIN"){
            let path=PathBuf::from(path);
            if path.is_file(){*guard=Some(path.clone());return Ok(path);}
        }
        let path=tunnel_download::ensure(&self.cache_dir).await?;
        *guard=Some(path.clone());
        Ok(path)
    }
    async fn run_worker(self:&Arc<Self>,inst:InstanceConfig,gen:u64)->Result<()>{
        let binary=if self.local_only {None} else {
            self.phase(&inst.id,gen,"Preparing tunnel client".into()).await;
            Some(self.resolve_tunnel().await.context("Preparing tunnel client")?)
        };
        {
            let entries=self.entries.lock().await;
            if entries.get(&inst.id).map(|e|e.generation)!=Some(gen){return Ok(());}
        }
        let mut cmd=Command::new(&self.runtime_bin);
        if self.local_only {cmd.arg("--local-only");}
        cmd.env("WORKSPACE_ROOT",&inst.workspace_root)
            .env("OPENAI_TUNNEL_ID",&inst.tunnel_id)
            .env("OPENAI_API_KEY",&inst.api_key)
            .env("AI_LOCAL_HUB_TOOL_GROUPS",inst.tool_groups.join(","))
            .env("WORKSPACE_TOOLS_CACHE_DIR",&self.cache_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(bin)=binary{cmd.env("WORKSPACE_TOOLS_TUNNEL_BIN",bin);}
        #[cfg(unix)]{cmd.process_group(0);}
        let mut child=cmd.spawn().with_context(||format!("Could not start Rust worker {}",self.runtime_bin.display()))?;
        let stdin=child.stdin.take();
        let stdout=child.stdout.take().context("Worker stdout unavailable")?;
        let stderr=child.stderr.take().context("Worker stderr unavailable")?;
        let (stop_tx,stop_rx)=oneshot::channel();
        {
            let mut entries=self.entries.lock().await;
            let entry=entries.entry(inst.id.clone()).or_default();
            if entry.generation!=gen {
                drop(stdin);let _=child.kill().await;return Ok(());
            }
            entry.stop=Some(stop_tx);
            entry.active_worker=true;
        }
        let manager=Arc::clone(self);let c=inst.clone();
        let reader=tokio::spawn(async move{
            let mut lines=BufReader::new(stdout).lines();
            while let Ok(Some(line))=lines.next_line().await {
                if let Ok(event)=serde_json::from_str::<Value>(&line){
                    if let Some(kind)=event["type"].as_str(){
                        match kind{
                            "log"=>{if let Some(s)=event["message"].as_str(){manager.log(&c,s.to_string()).await;}},
                            "phase"=>{if let Some(s)=event["message"].as_str(){manager.phase(&c.id,gen,s.to_string()).await;}},
                            "mcp"=>{if let Some(s)=event["url"].as_str(){
                                let mut entries=manager.entries.lock().await;
                                let e=entries.entry(c.id.clone()).or_default();
                                if e.generation==gen{e.status.url=Some(s.into());}
                                let status=e.status.clone();drop(entries);
                                manager.broadcast(json!({"type":"status","id":c.id,"status":status}));
                            }},
                            "ready"=>{manager.status(&c.id,gen,Status{state:"running".into(),phase:None,url:{
                                let entries=manager.entries.lock().await;
                                entries.get(&c.id).and_then(|e|e.status.url.clone())
                            },tunnel_ready:event["tunnel"]==true,error:None}).await;},
                            "fatal"=>{if let Some(s)=event["message"].as_str(){manager.status(&c.id,gen,Status{state:"error".into(),phase:None,url:None,tunnel_ready:false,error:Some(s.replace(&c.api_key,"[REDACTED]"))}).await;}},
                            _=>{},
                        }
                        continue;
                    }
                }
                manager.log(&c,line).await;
            }
        });
        let manager=Arc::clone(self);let c=inst.clone();
        let errors=tokio::spawn(async move{
            let mut lines=BufReader::new(stderr).lines();
            while let Ok(Some(line))=lines.next_line().await{manager.log(&c,line).await;}
        });
        tokio::pin!(stop_rx);
        let stopped=tokio::select!{
            _=&mut stop_rx=>{
                drop(stdin);
                match timeout(Duration::from_secs(10),child.wait()).await {
                    Ok(r)=>{r?;},Err(_)=>{
                        #[cfg(unix)]{if let Some(pid)=child.id(){unsafe{libc::kill(-(pid as i32),libc::SIGKILL);}}}
                        let _=child.kill().await;
                        child.wait().await?;
                    }
                };
                true
            }
            status=child.wait()=>{let status=status?;if !status.success(){self.log(&inst,format!("Worker exited unexpectedly: {status}")).await;}false}
        };
        let _=reader.await;let _=errors.await;
        let mut entries=self.entries.lock().await;
        let entry=entries.entry(inst.id.clone()).or_default();
        // A stopped process must be fully released before another start is allowed.
        entry.stop=None;
        entry.active_worker=false;
        if entry.generation==gen || entry.status.state=="stopping" {
            if stopped || entry.status.state!="error" {
                entry.status=if stopped{Status::stopped()}else{Status{state:"error".into(),phase:None,url:None,tunnel_ready:false,error:Some("Worker exited unexpectedly".into())}};
            }
            let status=entry.status.clone();drop(entries);
            self.broadcast(json!({"type":"status","id":inst.id,"status":status}));
        }
        Ok(())
    }
    pub async fn stop(&self,id:&str){
        let mut entries=self.entries.lock().await;
        let entry=entries.entry(id.into()).or_default();
        if entry.status.state=="stopping" {return;}
        entry.generation+=1;
        if let Some(stop)=entry.stop.take(){
            entry.status.state="stopping".into();
            entry.status.phase=Some("Stopping".into());
            let status=entry.status.clone();drop(entries);
            self.broadcast(json!({"type":"status","id":id,"status":status}));
            let _=stop.send(());
        }else{
            entry.status=Status::stopped();
            let status=entry.status.clone();drop(entries);
            self.broadcast(json!({"type":"status","id":id,"status":status}));
        }
    }
    pub async fn stop_all(&self){
        let ids=self.config.lock().await.instances.iter().map(|c|c.id.clone()).collect::<Vec<_>>();
        for id in ids{self.stop(&id).await;}
    }
    pub async fn wait_stopped(&self){
        self.stop_all().await;
        for _ in 0..200{
            let entries=self.entries.lock().await;
            if entries.values().all(|e|!e.active_worker && e.stop.is_none()){break;}
            drop(entries);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
