// Startrack для Linux: окно Chromium (CEF) с тем же интерфейсом, что и в версии для Windows.
// WebKitGTK, на котором Tauri работает в Linux, во всех дистрибутивах собран без WebRTC — звонков
// и демонстрации экрана в нём нет. Поэтому здесь своя оболочка на Rust, а команды, которые интерфейс
// вызывает через __TAURI_INTERNALS__.invoke, отвечает bridge.rs.
use cef::*;
use std::cell::RefCell;
use std::sync::OnceLock;

#[path = "../../src-tauri/src/bypass.rs"]
mod bypass;
mod bridge;
mod cmds;
#[path = "../../src-tauri/src/games.rs"]
mod games;
mod update;

const ICON: &[u8] = include_bytes!("../../src-tauri/icons/128x128.png");
const ICON_256: &[u8] = include_bytes!("../../src-tauri/icons/128x128@2x.png");

/// Ключи Chromium для браузерного процесса (их же получают дочерние процессы).
static SWITCHES: OnceLock<Vec<(&'static str, String)>> = OnceLock::new();

thread_local! {
    // главное окно; живёт в потоке UI CEF, остальные потоки добираются до него через post_task
    static WINDOW: RefCell<Option<Window>> = const { RefCell::new(None) };
}

fn main() {
    // версия API CEF — до любого другого вызова CEF
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let args = args::Args::new();
    let Some(cmd_line) = args.as_cmd_line() else { std::process::exit(1) };

    // Рендер, GPU, сеть и т.п. — тот же бинарник с ключом --type=…
    if cmd_line.has_switch(Some(&CefString::from("type"))) != 0 {
        std::process::exit(execute_process(Some(args.as_main_args()), None, std::ptr::null_mut()));
    }

    // Уже запущен — его окно поднимется, а эта копия закрывается
    let Some(listener) = bridge::bind() else { return };
    cmds::install_desktop_entry(ICON_256);

    // Домены сервера направляем на локальный обход VPN (или хотя бы прямо на IP, минуя DNS)
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
    let target = rt.block_on(bypass::start());
    let rules = bypass::DOMAINS.iter().map(|d| format!("MAP {d} {target}")).collect::<Vec<_>>().join(", ");
    let _ = SWITCHES.set(vec![
        ("autoplay-policy", "no-user-gesture-required".into()),
        ("host-resolver-rules", rules),
        // демонстрация экрана в Wayland — через xdg-desktop-portal и PipeWire
        ("enable-features", "WebRTCPipeWireCapturer".into()),
        // без вопроса про пароль связки ключей GNOME/KDE при первом запуске
        ("password-store", "basic".into()),
    ]);
    bridge::serve(listener);

    let data = cmds::data_dir();
    let debug_port = std::env::var("STARTRACK_DEBUG_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let settings = Settings {
        // песочнице Chromium нужен SUID chrome-sandbox или user namespaces, а в Ubuntu 24.04 их режет AppArmor
        no_sandbox: 1,
        root_cache_path: CefString::from(data.to_string_lossy().as_ref()),
        cache_path: CefString::from(data.join("profile").to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        locale: CefString::from("ru"),
        log_severity: if cfg!(debug_assertions) { LogSeverity::WARNING } else { LogSeverity::DISABLE },
        background_color: 0xFF32_3339,
        remote_debugging_port: debug_port,
        ..Default::default()
    };
    let mut app = StApp::new();
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        eprintln!("Startrack: не удалось запустить CEF");
        std::process::exit(1);
    }
    run_message_loop();
    shutdown();
    drop(rt);
}

/// Поднять окно (повторный запуск, уведомление).
pub fn focus_window() {
    post_task(ThreadId::UI, Some(&mut FocusTask::new()));
}

/// Закрыть приложение (после установки обновления).
pub fn quit() {
    post_task(ThreadId::UI, Some(&mut QuitTask::new()));
}

wrap_task! {
    struct FocusTask;
    impl Task {
        fn execute(&self) {
            WINDOW.with_borrow(|w| {
                if let Some(w) = w {
                    if w.is_minimized() != 0 {
                        w.restore();
                    }
                    w.show();
                    w.activate();
                }
            });
        }
    }
}

wrap_task! {
    struct QuitTask;
    impl Task {
        fn execute(&self) {
            WINDOW.with_borrow(|w| {
                if let Some(w) = w {
                    w.close();
                }
            });
        }
    }
}

wrap_app! {
    struct StApp;
    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let browser = process_type.map(|t| t.to_string().is_empty()).unwrap_or(true);
            let (true, Some(cl), Some(switches)) = (browser, command_line, SWITCHES.get()) else { return };
            for (k, v) in switches {
                cl.append_switch_with_value(Some(&CefString::from(*k)), Some(&CefString::from(v.as_str())));
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(StBrowserProcess::new())
        }
    }
}

wrap_browser_process_handler! {
    struct StBrowserProcess;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            let url = CefString::from(format!("http://127.0.0.1:{}/", bridge::port()).as_str());
            let settings = BrowserSettings { background_color: 0xFF32_3339, ..Default::default() };
            let mut client = StClient::new();
            let view = browser_view_create(Some(&mut client), Some(&url), Some(&settings), None, None, Some(&mut StBrowserView::new()));
            window_create_top_level(Some(&mut StWindow::new(RefCell::new(view))));
        }
    }
}

wrap_browser_view_delegate! {
    struct StBrowserView {}
    impl ViewDelegate {}
    impl BrowserViewDelegate {
        // без адресной строки и вкладок Chrome — просто окно с приложением
        fn chrome_toolbar_type(&self, _browser_view: Option<&mut BrowserView>) -> ChromeToolbarType {
            ChromeToolbarType::NONE
        }
    }
}

wrap_window_delegate! {
    struct StWindow {
        view: RefCell<Option<BrowserView>>,
    }
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1200, height: 760 }
        }
        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 800, height: 500 }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let (Some(window), Some(view)) = (window, self.view.borrow().clone()) else { return };
            window.add_child_view(Some(&mut View::from(&view)));
            window.set_title(Some(&CefString::from("Startrack")));
            if let Some(mut icon) = image_create() {
                icon.add_png(1.0, Some(ICON));
                window.set_window_icon(Some(&mut icon));
                window.set_window_app_icon(Some(&mut icon));
            }
            window.show();
            WINDOW.with_borrow_mut(|w| *w = Some(window.clone()));
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.view.borrow_mut() = None;
            WINDOW.with_borrow_mut(|w| *w = None);
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            match self.view.borrow().as_ref().and_then(|v| v.browser()).and_then(|b| b.host()) {
                Some(host) => host.try_close_browser(),
                None => 1,
            }
        }
    }
}

wrap_client! {
    struct StClient;
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(StLifeSpan::new())
        }
        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(StPermissions::new())
        }
        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(StDownloads::new())
        }
        fn request_handler(&self) -> Option<RequestHandler> {
            Some(StRequests::new())
        }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(StContextMenu::new())
        }
    }
}

wrap_life_span_handler! {
    struct StLifeSpan;
    impl LifeSpanHandler {
        // target=_blank и window.open — во внешнем браузере
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            if let Some(url) = target_url {
                let _ = cmds::open_url(url.to_string());
            }
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            quit_message_loop();
        }
    }
}

wrap_permission_handler! {
    struct StPermissions;
    impl PermissionHandler {
        // Микрофон, камера и захват экрана — сразу, без вопроса (как allow_media в версии для Windows)
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let Some(callback) = callback else { return 0 };
            callback.cont(requested_permissions);
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            _requesting_origin: Option<&CefString>,
            _requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            let Some(callback) = callback else { return 0 };
            callback.cont(PermissionRequestResult::ACCEPT);
            1
        }
    }
}

wrap_download_handler! {
    struct StDownloads;
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _request_method: Option<&CefString>) -> i32 {
            1
        }

        // Вложения из чата — сразу в «Загрузки», без диалога; одноимённый файл не перезаписываем
        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            let Some(callback) = callback else { return 0 };
            let name = suggested_name.map(|n| n.to_string()).unwrap_or_default();
            let path = cmds::download_path(&name);
            callback.cont(Some(&CefString::from(path.to_string_lossy().as_ref())), 0);
            1
        }

        // Как download.rs в версии для Windows: сообщаем интерфейсу, куда сохранили
        fn on_download_updated(&self, browser: Option<&mut Browser>, item: Option<&mut DownloadItem>, _callback: Option<&mut DownloadItemCallback>) {
            let (Some(browser), Some(item)) = (browser, item) else { return };
            let ok = item.is_complete() != 0;
            if !ok && item.is_canceled() == 0 && item.is_interrupted() == 0 {
                return;
            }
            let path = CefString::from(&item.full_path()).to_string();
            let path = if path.is_empty() { serde_json::Value::Null } else { path.into() };
            let code = format!("window.__stDownload?.({path}, {ok})");
            if let Some(frame) = browser.main_frame() {
                frame.execute_java_script(Some(&CefString::from(code.as_str())), Some(&CefString::from("")), 0);
            }
        }
    }
}

wrap_request_handler! {
    struct StRequests;
    impl RequestHandler {
        // Само окно никуда не уходит со страницы приложения: чужие ссылки — во внешнем браузере.
        // Встроенные фреймы (плеер YouTube) не трогаем.
        fn on_before_browse(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _user_gesture: i32,
            _is_redirect: i32,
        ) -> i32 {
            let (Some(frame), Some(request)) = (frame, request) else { return 0 };
            if frame.is_main() == 0 {
                return 0;
            }
            let url = CefString::from(&request.url()).to_string();
            if url.starts_with(&format!("http://127.0.0.1:{}/", bridge::port())) || url.starts_with("devtools:") {
                return 0;
            }
            let _ = cmds::open_url(url);
            1
        }
    }
}

wrap_context_menu_handler! {
    struct StContextMenu;
    impl ContextMenuHandler {
        // Меню Chrome («Назад», «Просмотр кода» и т.п.) приложению ни к чему — оставляем его
        // только для полей ввода и выделенного текста (копировать, вставить)
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            let (Some(params), Some(model)) = (params, model) else { return };
            let selection = !CefString::from(&params.selection_text()).to_string().is_empty();
            if params.is_editable() == 0 && !selection {
                model.clear();
            }
        }
    }
}
