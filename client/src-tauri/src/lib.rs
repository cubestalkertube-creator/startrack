#[cfg(desktop)]
mod bypass;
#[cfg(desktop)]
mod download;
#[cfg(desktop)]
mod games;
#[cfg(desktop)]
mod update;
#[cfg(desktop)]
mod verity;

#[cfg(desktop)]
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop();
    #[cfg(mobile)]
    mobile();
}

// Телефон: одно окно на весь экран. Обход VPN и автообновление тут не нужны —
// новая версия ставится из APK, ссылку на который открывает браузер (open_url).
#[cfg(mobile)]
fn mobile() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_url, notify])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default()).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

// Открывает ссылку во внешнем браузере (на телефоне так скачиваются вложения и APK обновления,
// на компьютере — «Открыть в Steam» в профиле)
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("bad url".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn desktop() {
    let builder = tauri::Builder::default();
    // Повторный запуск показывает уже открытое окно (вторая копия с другими аргументами WebView2 упала бы).
    // В debug выключено, чтобы для тестов можно было открыть два окна.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(update::Pending::default())
        .manage(verity::State::default())
        .invoke_handler(tauri::generate_handler![
            route_adapter,
            notify,
            open_url,
            download::reveal_file,
            running_procs,
            update::update_check,
            update::update_install,
            update::update_progress,
            verity::verity_pc,
            verity::verity_set_mode,
            verity::verity_tool
        ])
        .setup(|app| {
            // Домены сервера направляем на локальный обход VPN (или хотя бы прямо на IP, минуя DNS)
            let target = tauri::async_runtime::block_on(bypass::start());
            let rules = bypass::DOMAINS
                .iter()
                .map(|d| format!("MAP {d} {target}"))
                .collect::<Vec<_>>()
                .join(", ");
            #[allow(unused_mut)]
            let mut args = format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                 --hide-screenshare-notification \
                 --autoplay-policy=no-user-gesture-required --host-resolver-rules=\"{rules}\""
            );
            // отладка WebView2 через CDP только в debug-сборке (порт задаёт STARTRACK_DEBUG_PORT)
            #[cfg(debug_assertions)]
            if let Ok(port) = std::env::var("STARTRACK_DEBUG_PORT") {
                args.push_str(&format!(
                    " --remote-debugging-port={port} --use-fake-device-for-media-stream --use-fake-ui-for-media-stream"
                ));
            }
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Startrack")
                .inner_size(1200.0, 760.0)
                .min_inner_size(800.0, 500.0)
                .additional_browser_args(&args)
                // перетаскивание файлов в чат обрабатывает страница (HTML5 drag-and-drop), а не Tauri
                .disable_drag_drop_handler()
                .on_download(download::on_download)
                .build()?;
            #[cfg(windows)]
            {
                allow_media(&win);
                hide_screenshare_bar();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

// Новое сообщение или звонок, пока приложение не в фокусе: системное уведомление
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

// Запущенные программы для «Играет в …» (games.rs общий с Linux-версией)
#[cfg(desktop)]
#[tauri::command]
async fn running_procs() -> Vec<serde_json::Value> {
    games::running_procs()
}

#[cfg(desktop)]
// Описание сетевого адаптера, через который Windows отправит трафик на ip.
// Клиент по нему понимает, что включён VPN в режиме TUN, и сразу звонит через TURN/TLS.
#[tauri::command]
fn route_adapter(ip: String) -> Option<String> {
    #[cfg(windows)]
    {
        let addr: std::net::Ipv4Addr = ip.parse().ok()?;
        let mut index = 0u32;
        let err = unsafe {
            windows::Win32::NetworkManagement::IpHelper::GetBestInterface(
                u32::from_ne_bytes(addr.octets()),
                &mut index,
            )
        };
        if err != 0 {
            return None;
        }
        let iface = netdev::get_interfaces().into_iter().find(|i| i.index == index)?;
        Some(format!(
            "{} | {} | {:?}",
            iface.friendly_name.unwrap_or(iface.name),
            iface.description.unwrap_or_default(),
            iface.if_type
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = ip;
        None
    }
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

// Скрывает системную плашку Chromium/WebView2 «tauri.localhost предоставляет доступ к вашему экрану»
#[cfg(windows)]
fn hide_screenshare_bar() {
    std::thread::spawn(|| {
        type HWND = isize;
        type BOOL = i32;
        type LPARAM = isize;

        #[link(name = "user32")]
        extern "system" {
            fn EnumWindows(lpEnumFunc: unsafe extern "system" fn(HWND, LPARAM) -> BOOL, lParam: LPARAM) -> BOOL;
            fn GetClassNameW(hWnd: HWND, lpClassName: *mut u16, nMaxCount: i32) -> i32;
            fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
            fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
            fn SetWindowPos(hWnd: HWND, hWndInsertAfter: HWND, X: i32, Y: i32, cx: i32, cy: i32, uFlags: u32) -> BOOL;
            fn IsWindowVisible(hWnd: HWND) -> BOOL;
        }

        unsafe extern "system" fn enum_cb(hwnd: HWND, _: LPARAM) -> BOOL {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut class_buf = [0u16; 128];
            let len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 128);
            if len <= 0 {
                return 1;
            }
            let class_name = String::from_utf16_lossy(&class_buf[..len as usize]);
            if !class_name.starts_with("Chrome_WidgetWin") {
                return 1;
            }

            let mut text_buf = [0u16; 512];
            let tlen = GetWindowTextW(hwnd, text_buf.as_mut_ptr(), 512);
            if tlen <= 0 {
                return 1;
            }
            let text = String::from_utf16_lossy(&text_buf[..tlen as usize]).to_lowercase();
            // В русской локализации: "http://tauri.localhost предоставляет доступ к вашему экрану."
            // В английской локализации: "http://tauri.localhost is sharing your screen."
            let is_screenshare_bar = text.contains("предоставляет доступ к вашему экрану")
                || text.contains("is sharing your screen")
                || (text.contains("tauri.localhost") && (text.contains("экран") || text.contains("screen") || text.contains("доступ") || text.contains("sharing")));

            if is_screenshare_bar {
                ShowWindow(hwnd, 0 /* SW_HIDE */);
                SetWindowPos(
                    hwnd,
                    0,
                    -32000,
                    -32000,
                    0,
                    0,
                    0x0001 /* SWP_NOSIZE */ | 0x0002 /* SWP_NOMOVE */ | 0x0004 /* SWP_NOZORDER */ | 0x0010 /* SWP_NOACTIVATE */ | 0x0080 /* SWP_HIDEWINDOW */,
                );
            }
            1
        }

        loop {
            unsafe {
                EnumWindows(enum_cb, 0);
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    });
}
