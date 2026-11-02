#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use gtk::prelude::*;
fn main() -> gtk::glib::ExitCode {
    if std::env::args().any(|arg| arg == "--version") {
        println!("Startrack {} (Rust + GTK 4)", env!("CARGO_PKG_VERSION"));
        return gtk::glib::ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    if let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
    {
        let share = root.join("share");
        if share.is_dir() {
            std::env::set_var("XDG_DATA_DIRS", &share);
            std::env::set_var("GSETTINGS_SCHEMA_DIR", share.join("glib-2.0/schemas"));
        }
    }
    let app = gtk::Application::builder()
        .application_id("app.startrack.native")
        .build();
    app.connect_activate(startrack::ui::launch);
    // --autostart is handled by our startup code, rather than GTK's option parser.
    app.run_with_args(&["startrack"])
}
