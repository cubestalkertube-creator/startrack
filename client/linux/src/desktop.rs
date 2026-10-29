// Трей и автозапуск — как tray.rs в версии для Windows. Крестик прячет окно (сообщения и звонки
// продолжают работать), щелчок по значку в трее возвращает его. Значок — StatusNotifierItem через
// D-Bus (KDE, Cinnamon, XFCE, GNOME с расширением AppIndicator, оно есть в Ubuntu). Если трея в
// системе нет, крестик закрывает приложение как раньше — иначе окно было бы не вернуть.
// Автозапуск — ~/.config/autostart/startrack.desktop (только для AppImage: нужен постоянный путь).
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub const AUTOSTART_ARG: &str = "--autostart";

static TRAY_ON: AtomicBool = AtomicBool::new(true); // настройка «Закрывать в трей»
static TRAY_OK: AtomicBool = AtomicBool::new(false); // значок действительно появился
static QUITTING: AtomicBool = AtomicBool::new(false);

fn marker(name: &str) -> PathBuf {
    crate::cmds::data_dir().join(name)
}

fn touch(p: PathBuf, on: bool) {
    if on {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, b"1");
    } else {
        let _ = std::fs::remove_file(p);
    }
}

pub fn init(rt: &tokio::runtime::Runtime) {
    TRAY_ON.store(!marker("no-tray").exists(), Ordering::Relaxed);
    if !marker("autostart-init").exists() {
        if autostart::set(true).is_ok() {
            touch(marker("autostart-init"), true);
        }
    } else if autostart::get() {
        let _ = autostart::set(true); // AppImage могли перенести
    }
    rt.spawn(async {
        use ksni::TrayMethods;
        match StTray.spawn().await {
            Ok(handle) => {
                TRAY_OK.store(true, Ordering::Relaxed);
                std::mem::forget(handle); // значок живёт, пока живо приложение
            }
            Err(e) => eprintln!("Startrack: трей недоступен: {e}"),
        }
    });
}

/// Крестик: спрятать окно вместо выхода?
pub fn hide_on_close() -> bool {
    if QUITTING.load(Ordering::Relaxed) || !TRAY_ON.load(Ordering::Relaxed) || !TRAY_OK.load(Ordering::Relaxed) {
        return false;
    }
    if !marker("tray-told").exists() {
        touch(marker("tray-told"), true);
        crate::cmds::notify(
            "Startrack работает в фоне".into(),
            "Сообщения и звонки продолжают приходить. Открыть — значок Startrack в трее. Выйти — правой кнопкой по значку.".into(),
        );
    }
    true
}

/// Выход по-настоящему (меню трея, установка обновления)
pub fn quitting() {
    QUITTING.store(true, Ordering::Relaxed);
}

pub fn prefs() -> Value {
    json!({ "tray": TRAY_ON.load(Ordering::Relaxed), "autostart": autostart::get() })
}

pub fn set_tray(on: bool) {
    TRAY_ON.store(on, Ordering::Relaxed);
    touch(marker("no-tray"), !on);
}

pub fn set_autostart(on: bool) -> Result<bool, String> {
    autostart::set(on)?;
    Ok(autostart::get())
}

mod autostart {
    use std::path::PathBuf;

    fn file() -> PathBuf {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
        config.join("autostart/startrack.desktop")
    }

    pub fn get() -> bool {
        file().exists()
    }

    pub fn set(on: bool) -> Result<(), String> {
        let f = file();
        if !on {
            let _ = std::fs::remove_file(&f);
            return Ok(());
        }
        let appimage = std::env::var("APPIMAGE").map_err(|_| "Автозапуск работает только для AppImage".to_string())?;
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Startrack\nComment=Мессенджер Startrack\nExec=\"{appimage}\" {}\nIcon=startrack\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
            super::AUTOSTART_ARG
        );
        if let Some(dir) = f.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&f, entry).map_err(|e| e.to_string())
    }
}

struct StTray;

impl ksni::Tray for StTray {
    fn id(&self) -> String {
        "startrack".into()
    }
    fn title(&self) -> String {
        "Startrack".into()
    }
    fn icon_name(&self) -> String {
        "startrack".into()
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        icon().into_iter().collect()
    }
    fn activate(&mut self, _x: i32, _y: i32) {
        crate::focus_window();
    }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        vec![
            StandardItem { label: "Открыть Startrack".into(), activate: Box::new(|_: &mut Self| crate::focus_window()), ..Default::default() }.into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: "Выйти из Startrack".into(),
                activate: Box::new(|_: &mut Self| {
                    quitting();
                    crate::quit();
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

// Значок для трея: PNG → ARGB32 (порядок байт сети), как требует StatusNotifierItem
fn icon() -> Option<ksni::Icon> {
    let decoder = png::Decoder::new(std::io::Cursor::new(crate::ICON));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let mut data = Vec::with_capacity(buf.len());
    for px in buf[..info.buffer_size()].chunks_exact(4) {
        data.extend_from_slice(&[px[3], px[0], px[1], px[2]]);
    }
    Some(ksni::Icon { width: info.width as i32, height: info.height as i32, data })
}

/// Запуск вместе с системой: окно сразу прячем (значок в трее появится чуть позже; если трея нет,
/// окно вернёт повторный запуск Startrack из меню приложений)
pub fn start_hidden() -> bool {
    TRAY_ON.load(Ordering::Relaxed)
}
