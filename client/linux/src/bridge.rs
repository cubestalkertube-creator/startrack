// Мост между интерфейсом и Rust. Интерфейс (client/dist, встроен в бинарник) отдаёт локальный
// HTTP-сервер на 127.0.0.1 — для Chromium это «безопасный» адрес, поэтому микрофон и демонстрация
// экрана работают. Вызовы __TAURI_INTERNALS__.invoke(cmd, args) из main.ts превращаются в
// POST /__invoke/<cmd>; ключ, который выдаётся на каждый запуск, не даёт дёргать команды чужим
// страницам и программам. Порт постоянный — от него зависит localStorage (вход в аккаунт),
// а занятый нашим же приложением порт значит, что Startrack уже запущен.
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");
static PORT: OnceLock<u16> = OnceLock::new();
static KEY: OnceLock<String> = OnceLock::new();
const FOCUS: &str = "startrack-focus";

pub fn port() -> u16 {
    *PORT.get().unwrap_or(&0)
}

/// Занимает порт интерфейса. None — Startrack уже запущен (его окно поднято).
pub fn bind() -> Option<TcpListener> {
    // STARTRACK_PORT — для второго окна при отладке (вместе с STARTRACK_PROFILE)
    let base = std::env::var("STARTRACK_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47811u16);
    let listener = (base..base + 10).find_map(|port| match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(l) => Some(Some(l)),
        Err(_) if ping(port) => Some(None),
        Err(_) => None,
    });
    let listener = match listener {
        Some(l) => l?,
        None => TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?,
    };
    let _ = PORT.set(listener.local_addr().ok()?.port());
    Some(listener)
}

// На порту наш Startrack? Заодно просим его показать окно.
fn ping(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(1)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.write_all(b"GET /__focus HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    let mut reply = String::new();
    let _ = s.read_to_string(&mut reply);
    reply.contains(FOCUS)
}

pub fn serve(listener: TcpListener) {
    let mut key = [0u8; 16];
    let _ = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut key));
    let _ = KEY.set(key.iter().map(|b| format!("{b:02x}")).collect());
    let server = Server::from_listener(listener, None).expect("http server");
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            // команды бывают долгими (скачивание обновления) — каждая в своём потоке
            std::thread::spawn(move || handle(req));
        }
    });
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn handle(mut req: Request) {
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    if path == "/__focus" {
        crate::focus_window();
        let _ = req.respond(Response::from_string(FOCUS));
        return;
    }
    if let Some(cmd) = path.strip_prefix("/__invoke/") {
        let authorized = *req.method() == Method::Post
            && req.headers().iter().any(|h| h.field.equiv("X-St-Key") && Some(h.value.as_str()) == KEY.get().map(String::as_str));
        if !authorized {
            let _ = req.respond(Response::empty(403));
            return;
        }
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let args: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let (status, value) = match invoke(cmd, &args) {
            Ok(v) => (200, v),
            Err(e) => (500, Value::String(e)),
        };
        let _ = req.respond(
            Response::from_string(value.to_string()).with_status_code(status).with_header(header("Content-Type", "application/json")),
        );
        return;
    }
    let file = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    let Some(f) = DIST.get_file(file) else {
        let _ = req.respond(Response::empty(404));
        return;
    };
    let ext = file.rsplit('.').next().unwrap_or("");
    let mime = match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    };
    let data = if file == "index.html" { with_shim(f.contents()) } else { f.contents().to_vec() };
    let cache = if file == "index.html" { "no-cache" } else { "max-age=31536000, immutable" };
    let _ = req.respond(Response::from_data(data).with_header(header("Content-Type", mime)).with_header(header("Cache-Control", cache)));
}

// То, что в Tauri делает сам Tauri: window.__TAURI_INTERNALS__.invoke
fn with_shim(html: &[u8]) -> Vec<u8> {
    let key = KEY.get().map(String::as_str).unwrap_or("");
    let shim = format!(
        "<script>window.__TAURI_INTERNALS__={{invoke:(c,a)=>fetch('/__invoke/'+c,{{method:'POST',headers:{{'X-St-Key':'{key}'}},\
         body:JSON.stringify(a||{{}})}}).then(r=>r.json().then(v=>r.ok?v:Promise.reject(v)))}};</script>"
    );
    String::from_utf8_lossy(html).replacen("<head>", &format!("<head>{shim}"), 1).into_bytes()
}

fn arg(args: &Value, name: &str) -> String {
    args.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
}

// Те же команды, что регистрирует client/src-tauri/src/lib.rs
fn invoke(cmd: &str, args: &Value) -> Result<Value, String> {
    Ok(match cmd {
        "route_adapter" => json!(crate::cmds::route_adapter(&arg(args, "ip"))),
        "notify" => json!(crate::cmds::notify(arg(args, "title"), arg(args, "body"))),
        "open_url" => json!(crate::cmds::open_url(arg(args, "url"))?),
        "reveal_file" => json!(crate::cmds::reveal_file(&arg(args, "path"))),
        "open_path" => json!(crate::cmds::open_path(&arg(args, "path"))?),
        "running_procs" => json!(crate::games::running_procs()),
        "update_check" => json!(crate::update::check()?),
        "update_install" => json!(crate::update::install()?),
        "update_progress" => json!(crate::update::progress()),
        "desktop_prefs" => crate::desktop::prefs(),
        "set_tray" => json!(crate::desktop::set_tray(args.get("on").and_then(Value::as_bool).unwrap_or(true))),
        "set_autostart" => json!(crate::desktop::set_autostart(args.get("on").and_then(Value::as_bool).unwrap_or(true))?),
        _ => return Err(format!("unknown command {cmd}")),
    })
}
