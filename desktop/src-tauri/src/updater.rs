use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::manager::{self, ManagerHost};

/// Gives the manager time to start before the first network request.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);
/// A server that stops sending would otherwise leave the download (and every later check) stuck;
/// the read timeout applies per read, so large downloads are fine.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// The UI listens for this event; the payload is an [`UpdateView`].
const STATE_EVENT: &str = "update-state";
const SETTINGS_FILE: &str = "updates.json";
/// Instances to start again after the app restarts into a new version.
const RESUME_FILE: &str = "resume-instances.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_install: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto_install: true }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    /// No newer version known.
    #[default]
    Idle,
    /// A newer version was found and waits for the user (or for the automatic install).
    Available,
    Downloading,
    Installing,
    /// Downloading, verifying or installing the newer version failed.
    Error,
}

/// What the UI shows. Sent as the [`STATE_EVENT`] payload and returned by `update_state`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current_version: String,
    auto_install: bool,
    phase: Phase,
    version: Option<String>,
    notes: Option<String>,
    /// Downloaded fraction (0 to 1) when the download size is known.
    progress: Option<f64>,
    error: Option<String>,
}

struct Inner {
    view: UpdateView,
    pending: Option<Update>,
    /// The version the OS notification was already shown for, so each version notifies once.
    notified: Option<String>,
    /// The version whose install failed. It is not installed automatically again in this session
    /// (a full download, maybe an admin prompt, every check); "Try again" still installs it.
    failed: Option<String>,
}

/// Desktop update state: settings, the newest known release and install progress.
pub struct Updates {
    inner: Mutex<Inner>,
    dir: Option<PathBuf>,
}

impl Updates {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn file(&self, name: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(name))
    }
}

/// Registers the update state and starts the periodic check (release builds only).
pub fn init(app: &AppHandle) {
    let dir = app.path().app_config_dir().ok();
    let settings: Settings = dir
        .as_ref()
        .and_then(|dir| fs::read(dir.join(SETTINGS_FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    app.manage(Updates {
        inner: Mutex::new(Inner {
            view: UpdateView {
                current_version: app.package_info().version.to_string(),
                auto_install: settings.auto_install,
                phase: Phase::Idle,
                version: None,
                notes: None,
                progress: None,
                error: None,
            },
            pending: None,
            notified: None,
            failed: None,
        }),
        dir,
    });
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_DELAY);
        loop {
            tauri::async_runtime::block_on(check(&app));
            thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// Reads and removes the instances saved before an update restart. Empty on a normal launch.
pub fn take_resume(app: &AppHandle) -> Vec<String> {
    let Some(path) = app.state::<Updates>().file(RESUME_FILE) else {
        return Vec::new();
    };
    let names = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let _ = fs::remove_file(&path);
    names
}

fn save_resume(app: &AppHandle, names: &[String]) {
    let Some(path) = app.state::<Updates>().file(RESUME_FILE) else {
        return;
    };
    if names.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }
    let saved = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|_| fs::write(&path, serde_json::to_vec(names).unwrap_or_default()));
    if let Err(error) = saved {
        eprintln!("cannot remember running instances for the update restart: {error}");
    }
}

/// Applies a change to the view and sends the result to the UI.
fn publish(app: &AppHandle, change: impl FnOnce(&mut Inner)) -> UpdateView {
    let updates = app.state::<Updates>();
    let view = {
        let mut inner = updates.lock();
        change(&mut inner);
        inner.view.clone()
    };
    let _ = app.emit(STATE_EVENT, view.clone());
    view
}

fn busy(phase: Phase) -> bool {
    matches!(phase, Phase::Downloading | Phase::Installing)
}

/// Shown even while the window is hidden in the tray; the notification itself has no actions,
/// the UI banner carries the "Update and restart" button.
fn notify(app: &AppHandle, version: &str, auto_install: bool) {
    let (title, body) = if auto_install {
        (
            format!("Updating AI Local Hub to {version}"),
            "The app restarts by itself when the update is installed. Running instances start again.".to_string(),
        )
    } else {
        (
            format!("AI Local Hub {version} is available"),
            "Open AI Local Hub and choose Update and restart.".to_string(),
        )
    };
    let app = app.clone();
    // Linux delivers notifications over D-Bus, which can block; keep it off the update path.
    thread::spawn(move || {
        if let Err(error) = app.notification().builder().title(title).body(body).show() {
            eprintln!("cannot show the update notification: {error}");
        }
    });
}

async fn check(app: &AppHandle) {
    if busy(app.state::<Updates>().lock().view.phase) {
        return;
    }
    let host = app.clone();
    let found = match app
        .updater_builder()
        // Windows runs the installer and exits the process without `RunEvent::Exit`: stop the
        // manager and its workers first so the installer can replace their executables.
        .on_before_exit(move || host.state::<ManagerHost>().shutdown())
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            publish(app, |inner| {
                if busy(inner.view.phase) {
                    return;
                }
                inner.pending = None;
                inner.view.phase = Phase::Idle;
                inner.view.version = None;
                inner.view.notes = None;
                inner.view.error = None;
            });
            return;
        }
        // Offline or GitHub unreachable: keep what is known and try again next time.
        Err(error) => {
            eprintln!("update check failed: {error}");
            return;
        }
    };
    let version = update.version.clone();
    let mut first_notice = false;
    let mut install_started = false;
    let mut failed_before = false;
    let view = publish(app, |inner| {
        // "Update and restart" may have been clicked while this check was waiting on the network.
        install_started = busy(inner.view.phase);
        if install_started {
            return;
        }
        // Keep showing the failure (and its "Try again" button) instead of retrying on our own.
        failed_before = inner.failed.as_deref() == Some(version.as_str());
        if failed_before {
            inner.pending = Some(update);
            return;
        }
        first_notice = inner.notified.as_deref() != Some(version.as_str());
        inner.notified = Some(version.clone());
        inner.view.phase = Phase::Available;
        inner.view.version = Some(version.clone());
        inner.view.notes = update.body.clone();
        inner.view.progress = None;
        inner.view.error = None;
        inner.pending = Some(update);
    });
    if install_started || failed_before {
        return;
    }
    if first_notice {
        notify(app, &version, view.auto_install);
    }
    if view.auto_install {
        install(app).await;
    }
}

/// Downloads, verifies and installs the pending update, then restarts into it. Failures are
/// reported through the view and leave the current version running.
async fn install(app: &AppHandle) {
    let updates = app.state::<Updates>();
    let update = {
        let mut inner = updates.lock();
        if busy(inner.view.phase) {
            return;
        }
        let Some(update) = inner.pending.clone() else {
            return;
        };
        inner.view.phase = Phase::Downloading;
        inner.view.progress = None;
        inner.view.error = None;
        update
    };
    publish(app, |_| {});

    let fail = |error: String| {
        eprintln!("update failed: {error}");
        publish(app, |inner| {
            inner.failed = Some(update.version.clone());
            inner.view.phase = Phase::Error;
            inner.view.progress = None;
            inner.view.error = Some(error);
        });
    };

    let mut received = 0u64;
    let mut last_event = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|total| *total > 0) {
                    if last_event.elapsed() >= PROGRESS_EVENT_INTERVAL {
                        last_event = Instant::now();
                        let progress = (received as f64 / total as f64).min(1.0);
                        publish(app, |inner| inner.view.progress = Some(progress));
                    }
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => return fail(error.to_string()),
    };

    publish(app, |inner| {
        inner.view.phase = Phase::Installing;
        inner.view.progress = None;
    });
    // Capture this before anything stops: the next launch starts these instances again.
    let running = app.state::<ManagerHost>().running_instances().await;
    save_resume(app, &running);
    if let Err(error) = update.install(bytes) {
        if app.state::<ManagerHost>().is_stopped() {
            // Windows stops the manager before launching the installer; the launch failed, so
            // start it again together with the instances saved above.
            manager::restart(app);
        } else {
            save_resume(app, &[]);
        }
        return fail(error.to_string());
    }
    // macOS and Linux: the new version is in place. The restart goes through `RunEvent::Exit`,
    // which stops the manager and its workers before the new process starts.
    app.request_restart();
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateView {
    app.state::<Updates>().lock().view.clone()
}

#[tauri::command]
pub fn set_auto_install(app: AppHandle, enabled: bool) -> Result<UpdateView, String> {
    let updates = app.state::<Updates>();
    if let Some(path) = updates.file(SETTINGS_FILE) {
        let settings = Settings {
            auto_install: enabled,
        };
        path.parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|_| fs::write(&path, serde_json::to_vec(&settings).unwrap_or_default()))
            .map_err(|error| format!("cannot save the update setting: {error}"))?;
    }
    let view = publish(&app, |inner| inner.view.auto_install = enabled);
    if enabled && view.phase == Phase::Available {
        tauri::async_runtime::spawn(async move { install(&app).await });
    }
    Ok(view)
}

/// Starts the install in the background; progress and failures arrive as [`STATE_EVENT`]s.
#[tauri::command]
pub fn install_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move { install(&app).await });
}
