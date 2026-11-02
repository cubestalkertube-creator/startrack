use anyhow::Result;
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    TrayIcon, TrayIconBuilder, TrayIconEvent,
};

pub enum Action {
    Show,
    Quit,
}
pub struct Tray {
    _icon: TrayIcon,
    show: MenuItem,
    quit: MenuItem,
}
impl Tray {
    pub fn new() -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            use gtk::{gio, glib};
            let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)?;
            let result = bus.call_sync(
                Some("org.kde.StatusNotifierWatcher"),
                "/StatusNotifierWatcher",
                "org.freedesktop.DBus.Properties",
                "Get",
                Some(&glib::variant::ToVariant::to_variant(&(
                    "org.kde.StatusNotifierWatcher",
                    "IsStatusNotifierHostRegistered",
                ))),
                None,
                gio::DBusCallFlags::NONE,
                1500,
                gio::Cancellable::NONE,
            )?;
            let registered = result
                .get::<(glib::Variant,)>()
                .and_then(|(v,)| v.get::<bool>())
                .unwrap_or(false);
            anyhow::ensure!(registered, "В окружении рабочего стола нет службы трея");
        }
        let menu = Menu::new();
        let show = MenuItem::new("Открыть Startrack", true, None);
        let quit = MenuItem::new("Выйти из Startrack", true, None);
        menu.append_items(&[&show, &quit])?;
        let image = image::load_from_memory(include_bytes!("../icons/icon.png"))?.into_rgba8();
        let (w, h) = image.dimensions();
        let icon = tray_icon::Icon::from_rgba(image.into_raw(), w, h)?;
        let icon = TrayIconBuilder::new()
            .with_id("startrack")
            .with_icon(icon)
            .with_menu(Box::new(menu))
            .with_tooltip("Startrack")
            .with_menu_on_left_click(false)
            .build()?;
        Ok(Self {
            _icon: icon,
            show,
            quit,
        })
    }
    pub fn poll(&self) -> Option<Action> {
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id == self.quit.id() {
                return Some(Action::Quit);
            }
            if event.id == self.show.id() {
                return Some(Action::Show);
            }
        }
        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: tray_icon::MouseButton::Left,
                    button_state: tray_icon::MouseButtonState::Up,
                    ..
                }
            ) {
                return Some(Action::Show);
            }
        }
        None
    }
}

pub fn set_autostart(enabled: bool) -> Result<()> {
    let exe = std::env::current_exe()?;
    set_autostart_for(&exe, enabled)
}
#[cfg(windows)]
fn set_autostart_for(exe: &std::path::Path, enabled: bool) -> Result<()> {
    let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")?;
    if enabled {
        key.set_value(
            "StartrackNative",
            &format!("\"{}\" --autostart", exe.display()),
        )?;
    } else if let Err(e) = key.delete_value("StartrackNative") {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(e.into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn set_autostart_for(exe: &std::path::Path, enabled: bool) -> Result<()> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| anyhow::anyhow!("Не найден каталог настроек"))?;
    let dir = base.config_dir().join("autostart");
    let path = dir.join("app.startrack.native.desktop");
    if enabled {
        std::fs::create_dir_all(&dir)?;
        // Desktop Entry double-quoted arguments have their own escaping rules.
        let escaped = exe
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
            .replace('%', "%%");
        anyhow::ensure!(
            !escaped.contains(['\n', '\r']),
            "Недопустимый путь к приложению"
        );
        std::fs::write(path, format!("[Desktop Entry]\nType=Application\nName=Startrack\nExec=\"{escaped}\" --autostart\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"))?;
    } else if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(e.into());
        }
    }
    Ok(())
}
