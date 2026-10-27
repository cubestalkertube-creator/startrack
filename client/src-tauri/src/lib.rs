#[cfg(desktop)]
mod bypass;
#[cfg(desktop)]
mod download;
#[cfg(desktop)]
mod update;

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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_url])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default()).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

// Открывает ссылку во внешнем браузере (на телефоне так скачиваются вложения и APK обновления)
#[cfg(mobile)]
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
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![
            route_adapter,
            notify,
            download::reveal_file,
            update::update_check,
            update::update_install,
            update::update_progress
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
            allow_media(&win);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

// Новое сообщение, пока окно не в фокусе: уведомление Windows и мигающая кнопка на панели задач
#[cfg(desktop)]
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
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
