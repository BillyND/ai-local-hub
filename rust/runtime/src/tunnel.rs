use anyhow::{Context, Result};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{process::{Child, Command}, time::{sleep,timeout,Instant}};

fn command(binary:&str,key:&str) -> Command {
    let mut cmd=Command::new(binary);
    cmd.env_clear();
    for name in ["HOME","PATH","TMPDIR","TMP","TEMP","LANG","LC_ALL","SystemRoot","WINDIR","PATHEXT","ComSpec"] {
        if let Ok(value)=std::env::var(name) {cmd.env(name,value);}
    }
    cmd.env("CONTROL_PLANE_API_KEY",key)
       .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
       .kill_on_drop(true);
    cmd
}
pub async fn connect(binary:&str, dir:&Path, tunnel_id:&str, key:&str, mcp_url:&str) -> Result<Child> {
    let mut init=command(binary,key);
    init.args(["init","--profile-dir",&dir.to_string_lossy(),"--profile","ai-local-hub",
        "--sample","sample_mcp_remote_no_auth","--mcp-server-url",mcp_url,
        "--tunnel-id",tunnel_id,"--health-listen-addr","127.0.0.1:0","--force"]);
    let status=timeout(Duration::from_secs(15), init.status()).await.context("tunnel init timed out")??;
    if !status.success(){anyhow::bail!("tunnel-client init failed: {status}");}
    let url_file=dir.join("health.url");
    let mut run=command(binary,key);
    run.args(["run","--profile-dir",&dir.to_string_lossy(),"--profile","ai-local-hub",
        "--control-plane.api-key","env:CONTROL_PLANE_API_KEY",
        "--health.listen-addr","127.0.0.1:0","--health.url-file",&url_file.to_string_lossy()]);
    let mut child=run.spawn().context("starting tunnel-client")?;
    let deadline=Instant::now()+Duration::from_secs(30);
    let client=reqwest::Client::builder().timeout(Duration::from_secs(2)).build()?;
    loop {
        if Instant::now()>deadline {anyhow::bail!("tunnel-client readiness timed out");}
        if child.try_wait()?.is_some(){anyhow::bail!("tunnel-client exited before ready");}
        if let Ok(url)=tokio::fs::read_to_string(&url_file).await {
            let url=url.trim().trim_end_matches('/');
            if !url.is_empty() {
                if let (Ok(h),Ok(r))=(client.get(format!("{url}/healthz")).send().await,client.get(format!("{url}/readyz")).send().await) {
                    if h.status().is_success() && r.status().is_success(){return Ok(child);}
                }
            }
        }
        sleep(Duration::from_millis(150)).await;
    }
}
