// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod manager;
#[cfg(any(target_os = "macos", windows))]
mod tray;
mod updater;

use manager::{ManagerHost, Quit};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent, RESTART_EXIT_CODE};

/// Closing the window keeps the instances running in the background on macOS (reopen from the
/// Dock or menu bar) and Windows (tray). Linux has no dependable tray, so closing quits.
const HIDE_ON_CLOSE: bool = cfg!(any(target_os = "macos", windows));

/// Brings the main window back (second launch, tray click, Dock reopen).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            updater::update_state,
            updater::set_auto_install,
            updater::install_update
        ])
        .setup(|app| {
            #[cfg(any(target_os = "macos", windows))]
            if let Err(error) = tray::create(app.handle()) {
                eprintln!("tray icon unavailable: {error}");
            }
            // Before the manager starts: it reads the instances to resume after an update.
            updater::init(app.handle());
            manager::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if HIDE_ON_CLOSE {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| match event {
            // Quits that ask first (tray, UI Quit button, last window closed on Linux): stopping the
            // manager and its workers can take seconds, so it runs on a background thread with the
            // windows hidden, and the app exits once it is done; the UI thread never blocks on it.
            // An update restart cannot be deferred, so `RunEvent::Exit` stops the manager instead.
            RunEvent::ExitRequested { api, code, .. } => {
                if code == Some(RESTART_EXIT_CODE) {
                    return;
                }
                let Some(host) = app.try_state::<ManagerHost>() else { return };
                match host.begin_quit() {
                    Quit::Now => {}
                    Quit::Pending => api.prevent_exit(),
                    Quit::After(child) => {
                        api.prevent_exit();
                        for window in app.webview_windows().values() {
                            let _ = window.hide();
                        }
                        let app = app.clone();
                        std::thread::spawn(move || {
                            if let Some(host) = app.try_state::<ManagerHost>() {
                                host.stop(child);
                            }
                            app.exit(0);
                        });
                    }
                }
            }
            // Exits that skip `ExitRequested` (macOS Cmd+Q, Dock Quit, logout; update restarts): stop
            // the manager before the process goes away. A no-op once a background stop finished.
            RunEvent::Exit => {
                if let Some(host) = app.try_state::<ManagerHost>() {
                    host.shutdown();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
