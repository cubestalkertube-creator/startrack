// Запущенные программы для «Играет в …»: хвост пути (последние 4 части — без имени пользователя),
// время запуска и для Steam-игр appid с названием из appmanifest. Игру по ним узнаёт сервер.
use serde_json::{json, Value};
use std::collections::HashMap;

#[tauri::command]
pub async fn running_procs() -> Vec<Value> {
    let mut seen: HashMap<String, u64> = HashMap::new();
    for (path, start) in list() {
        let lower = path.to_lowercase().replace('\\', "/");
        if lower.starts_with("c:/windows/") {
            continue;
        }
        let e = seen.entry(path).or_insert(start);
        *e = (*e).min(start);
    }
    let me = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
    let mut steam_cache: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    seen.into_iter()
        .filter(|(p, _)| Some(p) != me.as_ref())
        .map(|(path, start)| {
            let norm = path.replace('\\', "/");
            let parts: Vec<&str> = norm.split('/').collect();
            let tail = parts[parts.len().saturating_sub(4)..].join("/");
            let steam = steam_app(&norm, &mut steam_cache);
            json!({ "p": tail, "t": start, "steam": steam.map(|(id, name)| json!([id, name])) })
        })
        .collect()
}

// .../steamapps/common/<папка>/... → appid и название из steamapps/appmanifest_*.acf с этим installdir
fn steam_app(path: &str, cache: &mut HashMap<String, Vec<(String, String, String)>>) -> Option<(String, String)> {
    let lower = path.to_lowercase();
    let i = lower.find("/steamapps/common/")?;
    let lib = &path[..i + "/steamapps".len()];
    let dir = path[i + "/steamapps/common/".len()..].split('/').next()?.to_lowercase();
    let apps = cache.entry(lib.to_lowercase()).or_insert_with(|| read_manifests(lib));
    apps.iter().find(|(_, _, d)| *d == dir).map(|(id, name, _)| (id.clone(), name.clone()))
}

fn read_manifests(lib: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(lib) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
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

// (полный путь к exe, время запуска в мс Unix) для всех процессов, к которым есть доступ
#[cfg(windows)]
fn list() -> Vec<(String, u64)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            if entry.th32ProcessID > 4 {
                if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                        let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                        let start = if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok() {
                            let t = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
                            t.saturating_sub(116_444_736_000_000_000) / 10_000
                        } else {
                            0
                        };
                        out.push((String::from_utf16_lossy(&buf[..len as usize]), start));
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

#[cfg(not(windows))]
fn list() -> Vec<(String, u64)> {
    Vec::new()
}
