fn main() {
    // Declaring the app commands puts them under ACL, so only the capabilities that grant them
    // (the loopback manager UI) can call them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["update_state", "set_auto_install", "install_update"]),
    ))
    .expect("failed to run tauri-build");
}
