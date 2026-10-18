//! Verified download/cache of the official OpenAI tunnel-client binary.
use anyhow::{bail,Context,Result};
use futures::StreamExt;
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{fs,io::{Cursor,Read},path::{Path,PathBuf}};
use uuid::Uuid;
#[derive(Deserialize)]
struct Asset{name:String,browser_download_url:String}
#[derive(Deserialize)]
struct Release{tag_name:String,assets:Vec<Asset>}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Manifest{version:String,platform:String,arch:String,asset_name:String,archive_sha256:String,binary_sha256:String,executable_name:String}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
async fn bounded(client:&reqwest::Client,url:&str,limit:usize)->Result<Vec<u8>>{
    let response=client.get(url).send().await?.error_for_status()?;
    if response.content_length().is_some_and(|n|n>limit as u64){bail!("Download exceeds size limit");}
    let mut stream=response.bytes_stream();
    let mut result=Vec::new();
    while let Some(chunk)=stream.next().await {
        let chunk=chunk?;
        if result.len()+chunk.len()>limit {bail!("Download exceeds size limit");}
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}
fn target()->Result<(&'static str,&'static str,&'static str)>{
    let platform=match std::env::consts::OS {"macos"=>"darwin","linux"=>"linux","windows"=>"windows",other=>bail!("Unsupported OS: {other}")};
    let arch=match std::env::consts::ARCH {"aarch64"=>"arm64","x86_64"=>"amd64",other=>bail!("Unsupported architecture: {other}")};
    if platform=="windows"&&arch=="arm64"{bail!("Windows arm64 tunnel client not supported");}
    Ok((platform,arch,if platform=="windows"{"tunnel-client.exe"}else{"tunnel-client"}))
}
fn verify(dir:&Path,version:&str,platform:&str,arch:&str,asset:&str,exe:&str)->Option<PathBuf>{
    let raw=fs::read(dir.join("manifest.json")).ok()?;
    let m:Manifest=serde_json::from_slice(&raw).ok()?;
    if m.version!=version||m.platform!=platform||m.arch!=arch||m.asset_name!=asset||m.executable_name!=exe{return None;}
    let bin=dir.join(exe);
    if !bin.is_file(){return None;}
    let raw=fs::read(&bin).ok()?;
    if raw.is_empty()||hash(&raw)!=m.binary_sha256{return None;}
    Some(bin)
}
/// Newest verified binary already in the cache: lets instances start while GitHub is unreachable.
fn newest_cached(cache_dir:&Path,platform:&str,arch:&str,exe:&str)->Option<PathBuf>{
    let mut best:Option<(std::time::SystemTime,PathBuf)>=None;
    for entry in fs::read_dir(cache_dir.join("tunnel-client")).ok()?.flatten(){
        let version=entry.file_name().to_string_lossy().into_owned();
        let dir=entry.path().join(format!("{platform}-{arch}"));
        let asset=format!("tunnel-client-{version}-{platform}-{arch}.zip");
        let Some(bin)=verify(&dir,&version,platform,arch,&asset,exe) else {continue};
        let at=fs::metadata(dir.join("manifest.json")).and_then(|m|m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(t,_)|at>*t){best=Some((at,bin));}
    }
    best.map(|(_,p)|p)
}
pub async fn ensure(cache_dir:&Path)->Result<PathBuf>{
    let (platform,arch,exe)=target()?;
    let client=reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .user_agent("AI-Local-Hub/0.1").build()?;
    let latest=async{
        client.get("https://api.github.com/repos/openai/tunnel-client/releases/latest")
            .timeout(std::time::Duration::from_secs(10))
            .send().await?.error_for_status()?.json::<Release>().await
    };
    let release=match latest.await{
        Ok(r)=>r,
        Err(e)=>return newest_cached(cache_dir,platform,arch,exe).ok_or_else(||anyhow::Error::new(e).context("Checking the latest tunnel-client release")),
    };
    let version=&release.tag_name;
    let valid=regex::Regex::new(r"^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$")?;
    if !valid.is_match(version){bail!("Invalid tunnel-client release tag");}
    let archive_name=format!("tunnel-client-{version}-{platform}-{arch}.zip");
    let sums=release.assets.iter().find(|a|a.name=="SHA256SUMS.txt").context("No official checksum asset")?;
    let archive=release.assets.iter().find(|a|a.name==archive_name).context("No archive for this platform")?;
    for asset in [sums,archive]{
        if !asset.browser_download_url.starts_with("https://github.com/openai/tunnel-client/releases/download/") {
            bail!("Refusing untrusted tunnel-client download URL");
        }
    }
    let dir=cache_dir.join("tunnel-client").join(version).join(format!("{platform}-{arch}"));
    if let Some(p)=verify(&dir,version,platform,arch,&archive_name,exe){return Ok(p);}
    let sum_data=bounded(&client,&sums.browser_download_url,1024*1024).await?;
    let sum_text=String::from_utf8(sum_data)?;
    let expected=sum_text.lines().find_map(|line|{
        let (hex,file)=line.trim().split_once(char::is_whitespace)?;
        if file.trim().trim_start_matches('*')==archive_name{Some(hex)}else{None}
    }).context("Archive not listed in official SHA256SUMS.txt")?;
    let zip_data=bounded(&client,&archive.browser_download_url,64*1024*1024).await?;
    let actual=hash(&zip_data);
    if !actual.eq_ignore_ascii_case(expected){bail!("Official tunnel-client archive SHA256 mismatch");}
    let mut archive_zip=zip::ZipArchive::new(Cursor::new(zip_data)).context("Invalid tunnel-client zip")?;
    let mut binary=None;
    for i in 0..archive_zip.len(){
        let file=archive_zip.by_index(i)?;
        if Path::new(file.name()).file_name().and_then(|n|n.to_str())==Some(exe) && !file.is_dir() {
            if file.size()>128*1024*1024 {bail!("Tunnel binary exceeds max size");}
            let mut data=Vec::new();
            file.take(128*1024*1024+1).read_to_end(&mut data)?;
            if data.len()>128*1024*1024{bail!("Tunnel binary exceeds max size");}
            binary=Some(data);break;
        }
    }
    let bytes=binary.context("Binary missing from vendor archive")?;
    let manifest=Manifest{version:version.clone(),platform:platform.into(),arch:arch.into(),asset_name:archive_name,archive_sha256:actual,binary_sha256:hash(&bytes),executable_name:exe.into()};
    let parent=dir.parent().context("No cache directory")?;
    fs::create_dir_all(parent)?;
    let stage=parent.join(format!(".stage-{}",Uuid::new_v4()));
    let written=(||->Result<()>{
        fs::create_dir(&stage)?;
        let binary_path=stage.join(exe);
        fs::write(&binary_path,&bytes)?;
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;fs::set_permissions(&binary_path,fs::Permissions::from_mode(0o755))?;}
        fs::write(stage.join("manifest.json"),serde_json::to_vec_pretty(&manifest)?)?;
        if dir.exists(){fs::remove_dir_all(&dir)?;}
        fs::rename(&stage,&dir)?;
        Ok(())
    })();
    if written.is_err(){let _=fs::remove_dir_all(&stage);}
    written?;
    Ok(dir.join(exe))
}
