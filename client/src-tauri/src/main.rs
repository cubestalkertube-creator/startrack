#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bypass;
mod update;

#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
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
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![
            route_adapter,
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
                .build()?;
            #[cfg(windows)]
            allow_media(&win);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Startrack");
}

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
