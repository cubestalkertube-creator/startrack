// Запущенные программы для «Играет в …»: хвост пути (последние 4 части — без имени пользователя),
// время запуска и для Steam-игр appid с названием из appmanifest. Игру по ним узнаёт сервер.
// Нативный сбор для Windows и Linux, без командной строки и браузера.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Process {
    pub p: String,
    pub t: u64,
    pub steam: Option<(String, String)>,
}

pub fn running_procs() -> Vec<Process> {
    reports(
        list(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned)),
    )
}

fn reports(processes: Vec<(String, u64, Option<String>)>, me: Option<String>) -> Vec<Process> {
    // путь -> (время запуска, appid из окружения процесса — только Linux)
    let mut seen: HashMap<String, (u64, Option<String>)> = HashMap::new();
    for (path, start, appid) in processes {
        let lower = path.to_lowercase().replace('\\', "/");
        if path.is_empty()
            || lower.starts_with("c:/windows/")
            || steam_tool(&lower)
            || me
                .as_ref()
                .is_some_and(|m| m.replace('\\', "/").eq_ignore_ascii_case(&lower))
        {
            continue;
        }
        let e = seen.entry(path).or_insert((start, appid.clone()));
        e.0 = e.0.min(start);
        if e.1.is_none() {
            e.1 = appid;
        }
    }
    let mut steam_cache: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    let mut out: Vec<_> = seen
        .into_iter()
        .map(|(path, (start, appid))| {
            let norm = path.replace('\\', "/");
            let tail = path_tail(&norm);
            let steam = match appid {
                Some(id) => {
                    let name = steam_name(&id, &mut steam_cache);
                    Some((id, name))
                }
                None => steam_app(&norm, &mut steam_cache),
            };
            Process {
                p: tail,
                t: start,
                steam,
            }
        })
        .collect();
    // Keep Steam games and recently started processes within the server's 400-entry limit.
    out.sort_by(|a, b| {
        b.steam
            .is_some()
            .cmp(&a.steam.is_some())
            .then(b.t.cmp(&a.t))
            .then(a.p.cmp(&b.p))
    });
    out.truncate(400);
    out.sort_by(|a, b| {
        a.p.cmp(&b.p)
            .then(a.t.cmp(&b.t))
            .then(a.steam.cmp(&b.steam))
    });
    out
}

fn path_tail(path: &str) -> String {
    let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
    // Never transmit the home-directory prefix, even for executables directly in it.
    let home = if parts
        .first()
        .is_some_and(|p| p.eq_ignore_ascii_case("home"))
    {
        2
    } else if parts.first() == Some(&"root") {
        1
    } else if parts
        .get(1)
        .is_some_and(|p| p.eq_ignore_ascii_case("users"))
    {
        3
    } else {
        0
    };
    parts[parts.len().saturating_sub(4).max(home.min(parts.len()))..].join("/")
}

/// Runs only while a socket is connected. One blocking scan at a time, off Tokio/GTK threads.
/// A fresh reporter always sends the full state, including after reconnecting.
pub(crate) async fn report(
    enabled: tokio::sync::watch::Receiver<bool>,
    outgoing: tokio::sync::mpsc::Sender<serde_json::Value>,
) {
    report_with(
        enabled,
        outgoing,
        running_procs,
        std::time::Duration::from_secs(15),
    )
    .await;
}

async fn report_with<F>(
    mut enabled: tokio::sync::watch::Receiver<bool>,
    outgoing: tokio::sync::mpsc::Sender<serde_json::Value>,
    scan_processes: F,
    interval: std::time::Duration,
) where
    F: Fn() -> Vec<Process> + Send + Clone + 'static,
{
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = None;
    loop {
        tokio::select! {
            _ = tick.tick() => {},
            change = enabled.changed() => if change.is_err() { return; },
        }
        let on = *enabled.borrow_and_update();
        let procs = if on {
            let mut scan = tokio::task::spawn_blocking(scan_processes.clone());
            // Disabling takes effect without waiting for a filesystem/process scan.
            tokio::select! {
                result = &mut scan => match result { Ok(p) => Some(p), Err(_) => continue },
                change = enabled.changed() => {
                    if change.is_err() { return; }
                    if !*enabled.borrow() {
                        let value = serde_json::json!({"type":"procs", "procs":null});
                        if outgoing.send(value.clone()).await.is_err() { return; }
                        last = Some(value);
                    }
                    // Don't start another blocking scan until this one releases native handles.
                    let _ = scan.await;
                    tick.reset_immediately();
                    continue;
                }
            }
        } else {
            None
        };
        if *enabled.borrow() != procs.is_some() {
            continue;
        }
        let value = serde_json::json!({"type":"procs", "procs":procs});
        if last.as_ref() != Some(&value) {
            if outgoing.send(value.clone()).await.is_err() {
                return;
            }
            last = Some(value);
        }
    }
}

// Служебное Steam, а не игра: контейнер Steam Linux Runtime, Proton, общие библиотеки
fn steam_tool(lower: &str) -> bool {
    let Some(i) = lower.find("/steamapps/common/") else {
        return lower.contains("/pressure-vessel/") || lower.contains("/steam-runtime");
    };
    let dir = lower[i + "/steamapps/common/".len()..]
        .split('/')
        .next()
        .unwrap_or("");
    dir.starts_with("steamlinuxruntime") || dir.starts_with("proton") || dir == "steamworks shared"
}

// Название игры по appid: appmanifest_<id>.acf в одной из библиотек Steam (Linux)
#[allow(unused_variables)]
fn steam_name(id: &str, cache: &mut HashMap<String, Vec<(String, String, String)>>) -> String {
    #[cfg(target_os = "linux")]
    for lib in linux_libraries() {
        let apps = cache
            .entry(lib.to_lowercase())
            .or_insert_with(|| read_manifests(&lib));
        if let Some((_, name, _)) = apps.iter().find(|(a, _, _)| a == id) {
            return name.clone();
        }
    }
    String::new()
}

// Папки steamapps всех библиотек: основная и перечисленные в libraryfolders.vdf
#[cfg(target_os = "linux")]
fn linux_libraries() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let roots = [
        ".steam/steam",
        ".local/share/Steam",
        ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        "snap/steam/common/.local/share/Steam",
    ];
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        let apps = format!("{home}/{r}/steamapps");
        let text =
            std::fs::read_to_string(format!("{apps}/libraryfolders.vdf")).unwrap_or_default();
        let mut libs = vec![apps];
        for line in text.lines() {
            let f: Vec<&str> = line.split('"').collect();
            if f.len() >= 4 && f[1].eq_ignore_ascii_case("path") {
                libs.push(format!("{}/steamapps", f[3]));
            }
        }
        for l in libs {
            let canon = std::fs::canonicalize(&l)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(l);
            if !out.contains(&canon) {
                out.push(canon);
            }
        }
    }
    out
}

// .../steamapps/common/<папка>/... → appid и название из steamapps/appmanifest_*.acf с этим installdir
fn steam_app(
    path: &str,
    cache: &mut HashMap<String, Vec<(String, String, String)>>,
) -> Option<(String, String)> {
    let parts: Vec<_> = path.split('/').collect();
    let i = parts.windows(2).position(|p| {
        p[0].eq_ignore_ascii_case("steamapps") && p[1].eq_ignore_ascii_case("common")
    })?;
    let lib = parts[..=i].join("/");
    let dir = parts.get(i + 2)?.to_lowercase();
    let apps = cache
        .entry(lib.to_lowercase())
        .or_insert_with(|| read_manifests(&lib));
    apps.iter()
        .find(|(_, _, d)| *d == dir)
        .map(|(id, name, _)| (id.clone(), name.clone()))
}

fn read_manifests(lib: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(lib) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let (mut id, mut title, mut dir) = (String::new(), String::new(), String::new());
        for line in text.lines() {
            // строки вида:	"appid"		"4000"
            let f: Vec<&str> = line.split('"').collect();
            if f.len() < 4 {
                continue;
            }
            match f[1].to_lowercase().as_str() {
                "appid" if id.is_empty() => id = f[3].to_string(),
                "name" if title.is_empty() => title = f[3].to_string(),
                "installdir" if dir.is_empty() => dir = f[3].to_lowercase(),
                _ => {}
            }
        }
        if !id.is_empty() && !dir.is_empty() {
            out.push((id, title, dir));
        }
    }
    out
}

// (полный путь к exe, время запуска в мс Unix, appid Steam из окружения) для всех процессов, к которым есть доступ
#[cfg(windows)]
fn list() -> Vec<(String, u64, Option<String>)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            if entry.th32ProcessID > 4 {
                if let Ok(h) = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    entry.th32ProcessID,
                ) {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(
                        h,
                        PROCESS_NAME_WIN32,
                        PWSTR(buf.as_mut_ptr()),
                        &mut len,
                    )
                    .is_ok()
                    {
                        let (mut c, mut x, mut k, mut u) = (
                            FILETIME::default(),
                            FILETIME::default(),
                            FILETIME::default(),
                            FILETIME::default(),
                        );
                        let start = if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok() {
                            let t = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
                            t.saturating_sub(116_444_736_000_000_000) / 10_000
                        } else {
                            0
                        };
                        out.push((String::from_utf16_lossy(&buf[..len as usize]), start, None));
                    }
                    let _ = CloseHandle(h);
                }
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

// Linux: /proc/<pid>/exe и время запуска из /proc/<pid>/stat. Игры под Wine/Proton видны как
// wine-preloader, поэтому у них берём argv[0] — путь к .exe (диск Z: — это корень Linux).
// Игры из Steam запускаются внутри контейнера Steam Linux Runtime и через Proton — по пути их не
// всегда узнать, зато Steam ставит всем процессам игры переменную SteamAppId.
#[cfg(target_os = "linux")]
fn list() -> Vec<(String, u64, Option<String>)> {
    let tick = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
    let boot = std::fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("btime ")?.trim().parse::<u64>().ok())
        })
        .unwrap_or(0);
    let system = [
        "/usr/",
        "/bin/",
        "/sbin/",
        "/lib",
        "/opt/google/",
        "/snap/",
        "/app/",
        "/tmp/.mount_",
    ];
    // сам Startrack из AppImage (его распакованный бинарник отсеивает current_exe)
    let appimage = std::env::var("APPIMAGE").unwrap_or_default();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return out;
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !e
            .file_name()
            .to_string_lossy()
            .bytes()
            .all(|b| b.is_ascii_digit())
        {
            continue;
        }
        let Ok(exe) = std::fs::read_link(dir.join("exe")) else {
            continue;
        };
        let mut path = exe
            .to_string_lossy()
            .trim_end_matches(" (deleted)")
            .to_string();
        let appid = std::fs::read(dir.join("environ")).ok().and_then(|env| {
            env.split(|&b| b == 0).find_map(|kv| {
                let v = std::str::from_utf8(kv.strip_prefix(b"SteamAppId=")?).ok()?;
                (v != "0"
                    && !v.is_empty()
                    && v.len() <= 10
                    && v.bytes().all(|b| b.is_ascii_digit()))
                .then(|| v.to_string())
            })
        });
        let file = path.rsplit('/').next().unwrap_or("");
        if appid.is_some() {
            // процесс игры из Steam (в том числе обёртки контейнера) — оставляем как есть
        } else if file.starts_with("wine") || file.contains("preloader") {
            let cmd = std::fs::read(dir.join("cmdline")).unwrap_or_default();
            let argv0 =
                String::from_utf8_lossy(cmd.split(|&b| b == 0).next().unwrap_or(&[])).to_string();
            let b = argv0.as_bytes();
            if b.len() < 3 || b[1] != b':' || !argv0.to_lowercase().ends_with(".exe") {
                continue;
            }
            path = if b[0].eq_ignore_ascii_case(&b'z') {
                argv0[2..].replace('\\', "/")
            } else {
                argv0
            };
        } else if system.iter().any(|p| path.starts_with(p)) || path == appimage {
            continue;
        }
        // поля после «(имя)»: starttime — 22-е поле, то есть 20-е после скобки
        let start = std::fs::read_to_string(dir.join("stat"))
            .ok()
            .and_then(|s| {
                s.rsplit_once(')')?
                    .1
                    .split_whitespace()
                    .nth(19)?
                    .parse::<u64>()
                    .ok()
            })
            .map(|t| (boot + t / tick) * 1000)
            .unwrap_or(0);
        out.push((path, start, appid));
    }
    out
}

#[cfg(not(any(windows, target_os = "linux")))]
fn list() -> Vec<(String, u64, Option<String>)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[test]
    fn process_reports_strip_home_skip_helpers_dedupe_and_sort() {
        let processes = vec![
            (r"C:\Users\PRIVATE_NAME\Games\game.exe".into(), 20, None),
            (r"C:\Users\PRIVATE_NAME\Games\game.exe".into(), 10, None),
            ("/home/PRIVATE_NAME/game".into(), 40, None),
            (r"C:\Windows\System32\service.exe".into(), 2, None),
            (
                "/lib/steamapps/common/Proton 9.0/proton".into(),
                50,
                Some("1".into()),
            ),
            ("/opt/startrack".into(), 30, None),
        ];
        let actual = reports(processes.clone(), Some("/opt/startrack".into()));
        let reversed = reports(
            processes.into_iter().rev().collect(),
            Some("/opt/startrack".into()),
        );
        assert_eq!(actual, reversed);
        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].p, "Games/game.exe");
        assert_eq!(actual[0].t, 10);
        assert!(!serde_json::to_string(&actual)
            .unwrap()
            .contains("PRIVATE_NAME"));
        assert_eq!(path_tail("/root/game"), "game");
        assert_eq!(
            path_tail("D:/Games/A/bin/win64/game.exe"),
            "A/bin/win64/game.exe"
        );
        let many = (0..450).map(|i| (format!("/games/{i}"), i, None)).collect();
        let capped = reports(many, None);
        assert_eq!(capped.len(), 400);
        assert!(capped.iter().all(|p| p.t >= 50));
    }

    #[test]
    fn steam_manifest_matches_unicode_library_and_install_directory() {
        let temp = tempfile::tempdir().unwrap();
        let apps = temp.path().join("İгры").join("steamapps");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("appmanifest_4000.acf"), "\"AppState\"\n{\n\"appid\" \"4000\"\n\"name\" \"Test Game\"\n\"installdir\" \"Test Game\"\n}").unwrap();
        let path = apps
            .join("common/Test Game/bin/game.exe")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            steam_app(&path, &mut HashMap::new()),
            Some(("4000".into(), "Test Game".into()))
        );
        assert_eq!(
            steam_app(
                &path.replace("Test Game/bin", "Other/bin"),
                &mut HashMap::new()
            ),
            None
        );
    }

    #[tokio::test]
    async fn reports_clear_immediately_while_scanning_and_resend_after_reconnect() {
        let (enabled, rx) = tokio::sync::watch::channel(false);
        let (out, mut frames) = tokio::sync::mpsc::channel(4);
        let entered = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(AtomicBool::new(false));
        struct Release(Arc<AtomicBool>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _release_on_failure = Release(release.clone());
        let scan = {
            let entered = entered.clone();
            let release = release.clone();
            move || {
                entered.fetch_add(1, Ordering::SeqCst);
                while !release.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                vec![Process {
                    p: "game.exe".into(),
                    t: 1,
                    steam: None,
                }]
            }
        };
        let task = tokio::spawn(report_with(
            rx,
            out,
            scan.clone(),
            Duration::from_millis(20),
        ));
        let first = frames.recv().await.unwrap();
        assert!(first["procs"].is_null());
        assert_eq!(entered.load(Ordering::SeqCst), 0);
        enabled.send_replace(true);
        tokio::time::timeout(Duration::from_secs(2), async {
            while entered.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        enabled.send_replace(false);
        let cleared = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(cleared["procs"].is_null());
        assert!(!release.load(Ordering::SeqCst));
        release.store(true, Ordering::SeqCst);
        enabled.send_replace(true);
        let published = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(published["procs"][0]["p"], "game.exe");
        assert!(
            tokio::time::timeout(Duration::from_millis(70), frames.recv())
                .await
                .is_err()
        );
        task.abort();
        let _ = task.await;
        let (out, mut frames) = tokio::sync::mpsc::channel(4);
        let task = tokio::spawn(report_with(
            enabled.subscribe(),
            out,
            scan,
            Duration::from_millis(20),
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), frames.recv())
                .await
                .unwrap()
                .unwrap(),
            published
        );
        task.abort();
        let _ = task.await;
    }
}
