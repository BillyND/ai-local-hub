// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod manager;
#[cfg(any(target_os = "macos", windows))]
mod tray;

use manager::ManagerHost;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

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
        .setup(|app| {
            #[cfg(any(target_os = "macos", windows))]
            if let Err(error) = tray::create(app.handle()) {
                eprintln!("tray icon unavailable: {error}");
            }
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
            // Runs on every quit path (tray, UI Quit button, OS shutdown): stop the manager and
            // its workers before the process goes away.
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
