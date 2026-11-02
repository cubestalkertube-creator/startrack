//! Offline signing utility. Key material is never logged or bundled with the client.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
fn main() -> Result<()> {
    let file = std::env::args_os()
        .nth(1)
        .context("Укажите путь к архиву или Linux-бинарнику")?;
    let configured = std::env::var("TAURI_SIGNING_PRIVATE_KEY").ok();
    let default = directories::BaseDirs::new()
        .context("Не найден домашний каталог")?
        .home_dir()
        .join(".tauri/startrack-updater.key");
    let key = if let Some(configured) = configured {
        if std::path::Path::new(&configured).is_file() {
            std::fs::read_to_string(configured)?
        } else {
            configured
        }
    } else {
        std::fs::read_to_string(default).context("Нет прежнего ключа подписи Startrack")?
    };
    let key = if key.trim_start().starts_with("untrusted comment:") {
        key
    } else {
        String::from_utf8(STANDARD.decode(key.trim())?)?
    };
    let secret = minisign::SecretKeyBox::from_string(&key)?
        .into_secret_key(Some(
            std::env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default(),
        ))
        .context("Не удалось открыть ключ. Проверьте TAURI_SIGNING_PRIVATE_KEY_PASSWORD")?;
    let public = minisign::PublicKey::from_secret_key(&secret)?;
    let bytes = std::fs::read(&file)?;
    let platform = if std::path::Path::new(&file)
        .extension()
        .is_some_and(|e| e == "zip")
    {
        "windows-x86_64"
    } else {
        "linux-x86_64"
    };
    let comment = format!("Startrack native {} {platform}", env!("CARGO_PKG_VERSION"));
    let signature = minisign::sign(
        Some(&public),
        &secret,
        std::io::Cursor::new(&bytes),
        Some(&comment),
        None,
    )?
    .to_string();
    // Reject a different key before creating assets that installed clients cannot accept.
    startrack::update::verify(&bytes, &signature)?;
    let path = std::path::PathBuf::from(file);
    let mut signature_path = path.as_os_str().to_os_string();
    signature_path.push(".sig");
    std::fs::write(signature_path, STANDARD.encode(signature.as_bytes()))?;
    println!("Подпись проверена: {}", path.display());
    Ok(())
}
