use anyhow::{bail,Context,Result};
use serde::{Deserialize,Serialize};
use std::{env,fs,path::{Path,PathBuf}};
use uuid::Uuid;
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InstanceConfig {pub id:String,pub name:String,pub workspace_root:String,pub tunnel_id:String,pub api_key:String}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct StoredConfig {pub version:u8,pub cache_dir:String,pub instances:Vec<InstanceConfig>}
#[derive(Debug,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InstanceInput {pub name:String,pub workspace_root:String,pub tunnel_id:String,#[serde(default)]pub api_key:String}
pub fn home()->PathBuf{dirs::home_dir().unwrap_or_else(||PathBuf::from("."))}
fn expand(s:&str)->PathBuf {
    if s=="~"{home()} else if let Some(s)=s.strip_prefix("~/"){home().join(s)}else{PathBuf::from(s)}
}
pub fn config_path()->PathBuf {
    env::var("WORKSPACE_TOOLS_CONFIG_FILE").ok().filter(|s|!s.trim().is_empty())
        .map(|s|expand(s.trim())).unwrap_or_else(||home().join(".config/workspace-tools-mcp/config.json"))
}
pub fn cache_dir(saved:&StoredConfig)->PathBuf{
    env::var("WORKSPACE_TOOLS_CACHE_DIR").ok().filter(|s|!s.trim().is_empty())
        .map(|s|expand(s.trim())).unwrap_or_else(||expand(&saved.cache_dir))
}
pub fn load(path:&Path)->Result<StoredConfig>{
    if !path.exists(){return Ok(StoredConfig{version:2,cache_dir:home().join(".cache/workspace-tools-mcp").to_string_lossy().into(),instances:vec![]});}
    let raw=fs::read(path).with_context(||format!("Read config {}",path.display()))?;
    let val:serde_json::Value=serde_json::from_slice(&raw).context("Invalid saved JSON config")?;
    let config:StoredConfig=if val["version"]==1{
        let tunnel=val["openaiTunnelId"].as_str().context("Invalid legacy tunnelId")?;
        let key=val["openaiApiKey"].as_str().context("Invalid legacy key")?;
        let workspace=val["workspaceRoot"].as_str().context("Invalid legacy workspaceRoot")?;
        let cache=val["cacheDir"].as_str().context("Invalid legacy cacheDir")?;
        StoredConfig{version:2,cache_dir:cache.into(),instances:if key.is_empty()||tunnel.is_empty(){vec![]}else{vec![InstanceConfig{id:"default".into(),name:"default".into(),workspace_root:workspace.into(),tunnel_id:tunnel.into(),api_key:key.into()}]}}
    }else{
        serde_json::from_value(val).context("Invalid config structure")?
    };
    if config.version!=2 {bail!("Unsupported saved config version");}
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;fs::set_permissions(path,fs::Permissions::from_mode(0o600))?;}
    Ok(config)
}
pub fn save(path:&Path,config:&StoredConfig)->Result<()>{
    if let Some(dir)=path.parent(){fs::create_dir_all(dir)?;}
    let temp=path.with_extension(format!("{}.tmp",Uuid::new_v4()));
    let result=(||->Result<()>{
        let data=serde_json::to_vec_pretty(config)?;
        let mut file=fs::OpenOptions::new().create_new(true).write(true).open(&temp)?;
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;file.set_permissions(fs::Permissions::from_mode(0o600))?;}
        use std::io::Write;file.write_all(&data)?;file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp,path)?;
        Ok(())
    })();
    if result.is_err(){let _=fs::remove_file(&temp);}
    result
}
pub fn normalize(input:InstanceInput,others:&[InstanceConfig],existing_id:Option<&str>)->Result<InstanceConfig>{
    let name=input.name.trim().to_string();
    let tunnel_id=input.tunnel_id.trim().to_string();
    let api_key=input.api_key.trim().to_string();
    if name.is_empty(){bail!("Name is required.");}
    if name.chars().count()>40{bail!("Name must be at most 40 characters.");}
    if tunnel_id.is_empty(){bail!("OpenAI Tunnel ID is required.");}
    if api_key.is_empty(){bail!("OpenAI API key is required.");}
    if others.iter().any(|o|o.name.eq_ignore_ascii_case(&name)){bail!("An instance named \"{name}\" already exists.");}
    if others.iter().any(|o|o.tunnel_id==tunnel_id){bail!("Tunnel ID {tunnel_id} is already used by another instance.");}
    let workspace=expand(input.workspace_root.trim());
    let workspace=if workspace.is_absolute(){workspace}else{env::current_dir()?.join(workspace)};
    let workspace=workspace.canonicalize().with_context(||format!("Workspace folder must be an existing directory: {}",workspace.display()))?;
    if !workspace.is_dir(){bail!("Workspace folder must be an existing directory");}
    Ok(InstanceConfig{id:existing_id.map(str::to_string).unwrap_or_else(||Uuid::new_v4().to_string()[..8].into()),name,workspace_root:workspace.to_string_lossy().into_owned(),tunnel_id,api_key})
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn invalid_duplicate_and_folder(){
        let i=InstanceInput{name:" alpha ".into(),workspace_root:".".into(),tunnel_id:"tunnel".into(),api_key:"key".into()};
        let one=normalize(i, &[],None).unwrap();
        let two=InstanceInput{name:"ALPHA".into(),workspace_root:".".into(),tunnel_id:"other".into(),api_key:"key".into()};
        assert!(normalize(two,&[one],None).is_err());
    }
}
