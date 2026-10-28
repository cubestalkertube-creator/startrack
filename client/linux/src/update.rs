// Автообновление AppImage — как tauri-plugin-updater в версии для Windows: latest.json последнего
// релиза на GitHub, файл для linux-x86_64-appimage, проверка подписи тем же ключом
// (~/.tauri/startrack-updater.key), замена своего AppImage и перезапуск.
// Если запущено не из AppImage (собрано вручную), обновлений не ищем.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const LATEST: &str = "https://github.com/cubestalkertube-creator/startrack/releases/latest/download/latest.json";
// тот же ключ, что plugins.updater.pubkey в client/src-tauri/tauri.conf.json
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE1MTM3RTAyMkYxOTAxRDQKUldUVUFSa3ZBbjRUcFdWdXlIeTAxSERpNFhLWFFPRVIyZzVQb2pRemlSejI3c2g3WWlZZnBZZ2YK";

struct Found {
    url: String,
    signature: String,
}

static PENDING: Mutex<Option<Found>> = Mutex::new(None);
static DONE: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(timeout))).build().into()
}

fn newer(a: &str, b: &str) -> bool {
    let num = |v: &str| v.trim_start_matches('v').split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    num(a) > num(b)
}

/// Есть ли версия новее. Возвращает (версия, описание изменений) или None.
pub fn check() -> Result<Option<(String, String)>, String> {
    if std::env::var_os("APPIMAGE").is_none() {
        return Ok(None);
    }
    // STARTRACK_UPDATE_URL — свой latest.json для проверки обновления (подпись всё равно нужна настоящая)
    let latest_url = std::env::var("STARTRACK_UPDATE_URL").unwrap_or_else(|_| LATEST.into());
    let text = agent(15)
        .get(&latest_url)
        .header("Cache-Control", "no-cache")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let latest: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let version = latest["version"].as_str().unwrap_or_default().to_string();
    if !newer(&version, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    let platforms = &latest["platforms"];
    let p = [&platforms["linux-x86_64-appimage"], &platforms["linux-x86_64"]].into_iter().find(|p| p["url"].is_string());
    let Some(p) = p else { return Ok(None) };
    *PENDING.lock().unwrap() = Some(Found {
        url: p["url"].as_str().unwrap_or_default().into(),
        signature: p["signature"].as_str().unwrap_or_default().into(),
    });
    Ok(Some((version, latest["notes"].as_str().unwrap_or_default().to_string())))
}

fn verify(data: &[u8], signature: &str) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let text = |s: &str| b64.decode(s.trim()).ok().and_then(|b| String::from_utf8(b).ok()).ok_or("Повреждённая подпись");
    let key = PublicKey::decode(&text(PUBKEY)?).map_err(|e| e.to_string())?;
    let sig = Signature::decode(&text(signature)?).map_err(|e| e.to_string())?;
    key.verify(data, &sig, true).map_err(|_| "Подпись обновления не совпадает".to_string())
}

/// Скачивает и ставит найденное обновление, затем перезапускает приложение.
pub fn install() -> Result<(), String> {
    let found = PENDING.lock().unwrap().take().ok_or("Обновление не найдено")?;
    let result = download_and_replace(&found);
    if result.is_err() {
        // оставляем обновление, чтобы можно было повторить
        *PENDING.lock().unwrap() = Some(found);
    }
    result
}

fn download_and_replace(found: &Found) -> Result<(), String> {
    let appimage = std::env::var("APPIMAGE").map_err(|_| "Запущено не из AppImage")?;
    DONE.store(0, Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    let mut resp = agent(600).get(&found.url).call().map_err(|e| e.to_string())?;
    let total = resp.headers().get("content-length").and_then(|v| v.to_str().ok()?.parse().ok()).unwrap_or(0);
    TOTAL.store(total, Ordering::Relaxed);
    let mut reader = resp.body_mut().with_config().limit(1 << 30).reader();
    let mut data = Vec::with_capacity(total as usize);
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        DONE.fetch_add(n as u64, Ordering::Relaxed);
    }
    verify(&data, &found.signature)?;
    // новый файл рядом и переименование поверх: запущенная копия продолжает работать со старым
    let tmp = format!("{appimage}.new");
    std::fs::write(&tmp, &data).map_err(|e| format!("Нет доступа к {appimage}: {e}"))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &appimage).map_err(|e| e.to_string())?;
    // перезапуск, когда эта копия освободит порт интерфейса
    std::process::Command::new("sh").args(["-c", "sleep 2; exec \"$0\"", &appimage]).spawn().map_err(|e| e.to_string())?;
    crate::quit();
    Ok(())
}

/// Сколько байт скачано и сколько всего (0 — неизвестно).
pub fn progress() -> (u64, u64) {
    (DONE.load(Ordering::Relaxed), TOTAL.load(Ordering::Relaxed))
}
