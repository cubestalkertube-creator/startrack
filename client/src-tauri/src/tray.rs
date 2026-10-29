// Как в Discord: крестик прячет окно в трей (сообщения и звонки продолжают работать), щелчок по
// значку в трее возвращает окно. Плюс автозапуск вместе с Windows — сразу в трей, без окна.
// Оба поведения включены по умолчанию и выключаются в Настройках → «Приложение».
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

/// Аргумент, с которым Windows запускает Startrack при входе в систему
pub const AUTOSTART_ARG: &str = "--autostart";

static TRAY: AtomicBool = AtomicBool::new(true);

fn marker(app: &AppHandle, name: &str) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(name))
}

fn touch(path: Option<PathBuf>, on: bool) {
    let Some(p) = path else { return };
    if on {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, b"1");
    } else {
        let _ = std::fs::remove_file(p);
    }
}

pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Значок в трее и перехват крестика. Вызывается из setup после создания окна.
pub fn init(app: &AppHandle, win: &WebviewWindow) -> tauri::Result<()> {
    TRAY.store(!marker(app, "no-tray").is_some_and(|p| p.exists()), Ordering::Relaxed);
    // первый запуск: автозапуск включаем сами (потом решает человек в настройках)
    let first = marker(app, "autostart-init");
    if first.as_ref().is_some_and(|p| !p.exists()) {
        let _ = autostart::set(true);
        touch(first, true);
    } else if autostart::get() {
        let _ = autostart::set(true); // путь к exe мог поменяться после переустановки
    }

    let open = MenuItemBuilder::with_id("open", "Открыть Startrack").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Выйти из Startrack").build(app)?;
    let menu = MenuBuilder::new(app).item(&open).separator().item(&quit).build()?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Startrack")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    let handle = app.clone();
    let w = win.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            if !TRAY.load(Ordering::Relaxed) {
                return;
            }
            api.prevent_close();
            let _ = w.hide();
            // один раз объясняем, куда делось окно
            let told = marker(&handle, "tray-told");
            if told.as_ref().is_some_and(|p| !p.exists()) {
                touch(told, true);
                use tauri_plugin_notification::NotificationExt;
                let _ = handle
                    .notification()
                    .builder()
                    .title("Startrack работает в фоне")
                    .body("Сообщения и звонки продолжают приходить. Открыть — значок Startrack в трее. Выйти — правой кнопкой по значку.")
                    .show();
            }
        }
    });
    Ok(())
}

/// Настройки для интерфейса
#[tauri::command]
pub fn desktop_prefs() -> serde_json::Value {
    serde_json::json!({ "tray": TRAY.load(Ordering::Relaxed), "autostart": autostart::get() })
}

#[tauri::command]
pub fn set_tray(app: AppHandle, on: bool) {
    TRAY.store(on, Ordering::Relaxed);
    touch(marker(&app, "no-tray"), !on);
}

#[tauri::command]
pub fn set_autostart(on: bool) -> Result<bool, String> {
    autostart::set(on)?;
    Ok(autostart::get())
}

// Автозапуск — значение в HKCU\...\CurrentVersion\Run (то же, что делают Discord и Steam)
#[cfg(windows)]
mod autostart {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "Startrack";

    pub fn get() -> bool {
        let mut size = 0u32;
        let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(KEY), &HSTRING::from(NAME), RRF_RT_REG_SZ, None, None, Some(&mut size)) };
        r.is_ok()
    }

    pub fn set(on: bool) -> Result<(), String> {
        let (key, name) = (HSTRING::from(KEY), HSTRING::from(NAME));
        if !on {
            let r = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &key, &name) };
            return if r.is_ok() || !get() { Ok(()) } else { Err(format!("реестр: {}", r.0)) };
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let value: Vec<u16> = format!("\"{}\" {}", exe.display(), super::AUTOSTART_ARG).encode_utf16().chain([0]).collect();
        let r = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, &key, PCWSTR(name.as_ptr()), REG_SZ.0, Some(value.as_ptr().cast()), (value.len() * 2) as u32)
        };
        if r.is_ok() { Ok(()) } else { Err(format!("реестр: {}", r.0)) }
    }
}

#[cfg(not(windows))]
mod autostart {
    pub fn get() -> bool {
        false
    }
    pub fn set(_on: bool) -> Result<(), String> {
        Ok(())
    }
}
