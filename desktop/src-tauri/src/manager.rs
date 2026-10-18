use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::{path::BaseDirectory, AppHandle, Manager, Url};

use crate::show_main;

/// Workers are stopped in parallel and each gets a 10 s grace period before escalation.
const STOP_TIMEOUT: Duration = Duration::from_secs(20);
const STDERR_TAIL_LINES: usize = 12;
/// How long the manager may take to print its ready line before it is considered hung.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// An attached (external) manager is considered gone after this many failed probes in a row.
const ATTACH_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const ATTACH_PROBE_FAILURES: u32 = 2;

/// Owns the embedded native Rust manager process.
#[derive(Default)]
pub struct ManagerHost {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
    /// UI address of the manager this app started, including its session token. Empty while
    /// starting and when attached to a manager started elsewhere.
    endpoint: Mutex<Option<Url>>,
    /// The bundled page the window opens on; it renders startup failures.
    splash: Option<Url>,
}

impl ManagerHost {
    fn child(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Closes the manager's stdin, which asks it to stop its workers and exit; kills it if it
    /// does not finish in time. Closing stdin also covers the shell dying, so no orphans remain.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut guard = self.child();
        let Some(child) = guard.as_mut() else { return };
        drop(child.stdin.take());
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => thread::sleep(Duration::from_millis(100)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// True once [`ManagerHost::shutdown`] ran (until [`restart`]).
    pub fn is_stopped(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Names of the instances that are running or starting in the manager this app owns.
    pub async fn running_instances(&self) -> Vec<String> {
        let Some(url) = self.endpoint.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return Vec::new();
        };
        match fetch_running(url).await {
            Ok(names) => names,
            Err(error) => {
                eprintln!("cannot read running instances: {error}");
                Vec::new()
            }
        }
    }
}

/// Reads `/api/state` with the session token the manager printed in its ready line.
async fn fetch_running(url: Url) -> Result<Vec<String>, String> {
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .ok_or("the manager address has no session token")?;
    let mut api = url;
    api.set_query(None);
    api.set_path("/api/state");
    let state: serde_json::Value = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .get(api)
        .header("Cookie", format!("wtm_session={token}"))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(state["instances"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|instance| {
            matches!(
                instance["status"]["state"].as_str(),
                Some("running" | "starting")
            )
        })
        .filter_map(|instance| instance["name"].as_str().map(str::to_string))
        .collect())
}

/// Collects the manager's stderr so a startup failure can show its cause.
struct Diagnostics {
    tail: Arc<Mutex<VecDeque<String>>>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl Diagnostics {
    fn capture(stderr: ChildStderr) -> Self {
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
        let sink = Arc::clone(&tail);
        let reader = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut lines = sink.lock().unwrap_or_else(|e| e.into_inner());
                lines.push_back(line);
                if lines.len() > STDERR_TAIL_LINES {
                    lines.pop_front();
                }
            }
        });
        Self {
            tail,
            reader: Mutex::new(Some(reader)),
        }
    }

    /// Builds the failure text. Waits briefly for the process to finish and the stderr reader to
    /// drain; otherwise the last lines (the actual cause) could still be in the pipe.
    fn describe(&self, what: &str, host: &ManagerHost) -> String {
        if let Some(child) = host.child().as_mut() {
            for _ in 0..20 {
                if !matches!(child.try_wait(), Ok(None)) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Some(reader) = self.reader.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = reader.join();
        }
        let lines = self.tail.lock().unwrap_or_else(|e| e.into_inner());
        let detail = lines.iter().cloned().collect::<Vec<_>>().join("\n");
        if detail.is_empty() {
            what.to_string()
        } else {
            format!("{what}\n\n{detail}")
        }
    }
}

/// Windows can hand back verbatim paths that subprocess APIs resolve poorly.
fn plain(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(stripped) = path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        return PathBuf::from(stripped);
    }
    path
}

/// Quits the app once an externally owned manager stops answering (for example after the UI's
/// Quit button): an attached window would otherwise stay open on a dead page.
fn watch_external(app: AppHandle, url: &Url) {
    let Some(address) = url
        .host_str()
        .zip(url.port_or_known_default())
        .and_then(|(host, port)| format!("{host}:{port}").parse::<SocketAddr>().ok())
    else {
        return;
    };
    thread::spawn(move || {
        let mut failures = 0;
        loop {
            thread::sleep(ATTACH_PROBE_INTERVAL);
            if TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok() {
                failures = 0;
                continue;
            }
            failures += 1;
            if failures >= ATTACH_PROBE_FAILURES {
                app.exit(0);
                return;
            }
        }
    });
}

/// Starts the manager on a background thread and points the window at it once it is ready.
pub fn start(app: AppHandle) {
    let splash = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok());
    app.manage(ManagerHost {
        splash,
        ..Default::default()
    });
    spawn_run(app);
}

/// Starts the manager again after [`ManagerHost::shutdown`], for example when an update could not
/// be installed after all; instances saved for resuming start with it.
pub fn restart(app: &AppHandle) {
    app.state::<ManagerHost>()
        .stopping
        .store(false, Ordering::SeqCst);
    spawn_run(app.clone());
}

fn spawn_run(app: AppHandle) {
    thread::spawn(move || {
        if let Err(message) = run(&app) {
            let splash = app.state::<ManagerHost>().splash.clone();
            show_error(&app, splash.as_ref(), &message);
        }
    });
}

fn run(app: &AppHandle) -> Result<(), String> {
    // Tauri installs sidecars next to the main executable on every platform.
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the app: {e}"))?;
    let bin_dir = exe.parent().ok_or("cannot locate the app directory")?;
    let manager_bin = plain(bin_dir.join(if cfg!(windows) {
        "ai-local-hub-manager.exe"
    } else {
        "ai-local-hub-manager"
    }));
    let worker_bin = plain(bin_dir.join(if cfg!(windows) {
        "ai-local-hub-runtime.exe"
    } else {
        "ai-local-hub-runtime"
    }));
    if !manager_bin.is_file() || !worker_bin.is_file() {
        return Err(format!(
            "native Rust manager or worker is missing: {} / {}",
            manager_bin.display(),
            worker_bin.display()
        ));
    }
    let web_dir = plain(app.path()
        .resolve("app/dist/web", BaseDirectory::Resource)
        .map_err(|e| format!("cannot locate the bundled web UI: {e}"))?);
    if !web_dir.join("index.html").is_file() {
        return Err(format!("bundled web UI is missing: {}", web_dir.display()));
    }
    let mut command = Command::new(&manager_bin);
    command.arg("--desktop");
    for name in crate::updater::take_resume(app) {
        command.arg("--instance").arg(name);
    }
    command
        .env("AI_LOCAL_HUB_RUNTIME_BIN", &worker_bin)
        .env("AI_LOCAL_HUB_WEB_DIR", &web_dir)
        .current_dir(&web_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot start the manager: {e}"))?;
    let stdout = child.stdout.take().ok_or("manager has no stdout")?;
    let stderr = child.stderr.take().ok_or("manager has no stderr")?;
    let host = app.state::<ManagerHost>();
    host.child().replace(child);

    let diagnostics = Diagnostics::capture(stderr);
    let failure = |what: &str| diagnostics.describe(what, &host);

    // A hung manager would leave the splash spinning forever: kill it so the read below fails.
    let ready = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (app, ready, timed_out) = (app.clone(), Arc::clone(&ready), Arc::clone(&timed_out));
        thread::spawn(move || {
            thread::sleep(READY_TIMEOUT);
            if !ready.load(Ordering::SeqCst) {
                timed_out.store(true, Ordering::SeqCst);
                if let Some(child) = app.state::<ManagerHost>().child().as_mut() {
                    let _ = child.kill();
                }
            }
        });
    }

    // The first stdout line is a JSON `ready` event; EOF before it means the manager died.
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| failure(&format!("cannot read from the manager: {e}")))?;
    let event: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| {
        if timed_out.load(Ordering::SeqCst) {
            failure("the manager did not start within 30 seconds")
        } else {
            failure("the manager exited before it was ready")
        }
    })?;
    let url = event["url"]
        .as_str()
        .filter(|_| event["type"] == "ready")
        .ok_or_else(|| failure("unexpected manager output"))?;
    ready.store(true, Ordering::SeqCst);
    let owner = event["owner"].as_bool().unwrap_or(true);
    let url = Url::parse(url).map_err(|e| format!("invalid manager address: {e}"))?;
    app.get_webview_window("main")
        .ok_or("main window is missing")?
        .navigate(url.clone())
        .map_err(|e| format!("cannot open the manager UI: {e}"))?;
    // Keep draining stdout so the pipe never fills.
    thread::spawn(move || for _ in reader.lines().map_while(Result::ok) {});

    if !owner {
        // Attached to a manager started elsewhere (for example `npm start`): not ours to stop,
        // but the app follows it, since there is nothing left to show once it goes away.
        host.child().take();
        watch_external(app.clone(), &url);
        return Ok(());
    }
    host.endpoint
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(url);

    // Watch the manager: a clean exit means Quit was chosen in the UI, anything else is a crash.
    loop {
        thread::sleep(Duration::from_millis(250));
        if host.stopping.load(Ordering::SeqCst) {
            return Ok(());
        }
        let status = match host.child().as_mut().map(Child::try_wait) {
            Some(Ok(Some(status))) => status,
            Some(Ok(None)) => continue,
            _ => return Ok(()),
        };
        if status.success() {
            app.exit(0);
            return Ok(());
        }
        return Err(failure(&format!(
            "the manager stopped unexpectedly ({status})"
        )));
    }
}

/// Shows the failure on the bundled splash page (it renders `#error=<message>`).
fn show_error(app: &AppHandle, splash: Option<&Url>, message: &str) {
    eprintln!("manager error: {message}");
    if let (Some(window), Some(splash)) = (app.get_webview_window("main"), splash) {
        let mut url = splash.clone();
        url.set_fragment(Some(&format!("error={}", encode(message))));
        let _ = window.navigate(url);
    }
    show_main(app);
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
