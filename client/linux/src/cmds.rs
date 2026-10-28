// Команды для интерфейса — то же, что в client/src-tauri делают lib.rs и download.rs, но средствами Linux.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Профиль Chromium (вход в аккаунт, настройки): ~/.local/share/startrack.
/// STARTRACK_PROFILE — отдельный профиль для второго окна при отладке.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"));
    let name = match std::env::var("STARTRACK_PROFILE") {
        Ok(p) if !p.is_empty() => format!("startrack-{p}"),
        _ => "startrack".into(),
    };
    base.join(name)
}

// Папка «Загрузки» из ~/.config/user-dirs.dirs (в русской системе это ~/Загрузки)
fn downloads_dir() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    let dir = std::fs::read_to_string(config.join("user-dirs.dirs")).ok().and_then(|s| {
        s.lines().find_map(|l| {
            let v = l.trim().strip_prefix("XDG_DOWNLOAD_DIR=")?.trim_matches('"');
            Some(PathBuf::from(v.replace("$HOME", &home().to_string_lossy())))
        })
    });
    dir.filter(|d| d.is_dir()).unwrap_or_else(|| home().join("Downloads"))
}

/// Куда сохранить вложение: «файл (1).pdf», если «файл.pdf» уже есть.
pub fn download_path(name: &str) -> PathBuf {
    let dir = downloads_dir();
    let _ = std::fs::create_dir_all(&dir);
    let name = Path::new(name).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = if name.is_empty() { "download".to_string() } else { name };
    let path = dir.join(&name);
    if !path.exists() {
        return path;
    }
    let p = Path::new(&name);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

fn spawn(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok()
}

/// Ссылка во внешнем браузере.
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("bad url".into());
    }
    if spawn("xdg-open", &[&url]) { Ok(()) } else { Err("xdg-open не найден".into()) }
}

/// Показать скачанный файл в файловом менеджере (выделенным, если менеджер это умеет).
pub fn reveal_file(path: &str) {
    let p = Path::new(path);
    if !p.is_file() {
        return;
    }
    let uri = format!("array:string:file://{path}");
    let shown = Command::new("dbus-send")
        .args(["--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1"])
        .args(["org.freedesktop.FileManager1.ShowItems", &uri, "string:"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !shown {
        if let Some(dir) = p.parent() {
            spawn("xdg-open", &[&dir.to_string_lossy()]);
        }
    }
}

/// Уведомление о новом сообщении, пока окно не в фокусе.
pub fn notify(title: String, body: String) {
    std::thread::spawn(move || {
        let _ = notify_rust::Notification::new().appname("Startrack").summary(&title).body(&body).show();
    });
}

/// Запущено из AppImage — ярлык в меню приложений (путь обновляется, если файл перенесли).
pub fn install_desktop_entry(icon: &[u8]) {
    let Ok(appimage) = std::env::var("APPIMAGE") else { return };
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"));
    let icon_path = data.join("icons/hicolor/256x256/apps/startrack.png");
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=Startrack\nComment=Мессенджер: друзья, сообщения, звонки и демонстрация экрана\n\
         Exec=\"{appimage}\" %U\nIcon=startrack\nCategories=Network;InstantMessaging;Chat;\nTerminal=false\n"
    );
    let file = data.join("applications/startrack.desktop");
    if std::fs::read_to_string(&file).is_ok_and(|s| s == entry) && icon_path.exists() {
        return;
    }
    for dir in [file.parent(), icon_path.parent()].into_iter().flatten() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&icon_path, icon);
    let _ = std::fs::write(&file, entry);
}

/// Через какой интерфейс пойдёт трафик на ip (`ip route get` учитывает и правила wg-quick).
/// Клиент по нему понимает, что включён VPN, и сразу звонит через TURN/TLS.
pub fn route_adapter(ip: &str) -> Option<String> {
    let ip: std::net::Ipv4Addr = ip.parse().ok()?;
    let out = Command::new("ip").args(["-4", "route", "get", &ip.to_string()]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let dev = text.split_whitespace().skip_while(|w| *w != "dev").nth(1)?.to_string();
    let kind = if crate::bypass::tunnel(&dev) || dev.starts_with("tun") || dev.starts_with("wg") { "tunnel" } else { "ethernet" };
    Some(format!("{dev} | {kind} | linux"))
}
