fn main() {
    // Custom commands must also pass origin/capability checks: chat apps are untrusted frames.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "route_adapter", "notify", "open_url", "reveal_file", "open_path", "running_procs",
            "update_check", "update_install", "update_progress", "verity_pc", "verity_set_mode",
            "verity_tool", "desktop_prefs", "set_tray", "set_autostart", "login_window",
        ]),
    )).expect("failed to build Startrack")
}
