#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            allow_media(&app.get_webview_window("main").expect("main window"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

// Микрофон/камера/захват экрана разрешаем сразу, без системного вопроса WebView2
#[cfg(windows)]
fn allow_media(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_ALLOW;
    use webview2_com::PermissionRequestedEventHandler;
    let _ = win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}
