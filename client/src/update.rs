//! Native bundles have a separate signed update channel; legacy NSIS releases are ignored.
use anyhow::{ensure, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    time::Duration,
};

const ENDPOINT: &str = "https://github.com/cubestalkertube-creator/startrack/releases/latest/download/native-latest.json";
const MAX_DOWNLOAD: usize = 200 * 1024 * 1024;
const PUBLIC_KEY: &str = "RWTUARkvAn4TpWVuyHy01HDi4XKXQOER2g5PojQziRz27sh7YiYfpYgf";
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Release {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    pub platforms: std::collections::BTreeMap<String, Bundle>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Bundle {
    pub url: String,
    pub signature: String,
}
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows-x86_64"
    } else {
        "linux-x86_64"
    }
}
impl Release {
    pub fn bundle(&self) -> Result<&Bundle> {
        self.platforms
            .get(platform())
            .context("Нет нативного обновления для этой системы")
    }
    fn validate(&self) -> Result<()> {
        semver::Version::parse(&self.version)?;
        let bundle = self.bundle()?;
        let url = url::Url::parse(&bundle.url)?;
        ensure!(
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url
                    .path()
                    .starts_with("/cubestalkertube-creator/startrack/releases/download/")
                && url.username().is_empty()
                && url.password().is_none(),
            "Недопустимый адрес обновления"
        );
        ensure!(bundle.signature.len() <= 4096, "Недопустимая подпись");
        Ok(())
    }
}
fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("Startrack/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(15))
        .https_only(true)
        .build()?)
}
pub async fn check() -> Result<Option<Release>> {
    let response = http()?
        .get(ENDPOINT)
        .timeout(Duration::from_secs(20))
        .header("Cache-Control", "no-cache")
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response.error_for_status()?;
    let bytes = bounded(response, 64 * 1024, |_, _| {}).await?;
    let release: Release = serde_json::from_slice(&bytes)?;
    release.validate()?;
    if semver::Version::parse(&release.version)?
        > semver::Version::parse(env!("CARGO_PKG_VERSION"))?
    {
        Ok(Some(release))
    } else {
        Ok(None)
    }
}
async fn bounded(
    response: reqwest::Response,
    max: usize,
    progress: impl Fn(u64, u64),
) -> Result<Vec<u8>> {
    let total = response.content_length().unwrap_or(0);
    ensure!(total <= max as u64, "Обновление слишком большое");
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            bytes.len() + chunk.len() <= max,
            "Обновление слишком большое"
        );
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}
pub fn verify(bytes: &[u8], signature: &str) -> Result<String> {
    use base64::Engine;
    let text = if signature.starts_with("untrusted comment:") {
        signature.to_string()
    } else {
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(signature.trim())?)?
    };
    let signature = minisign_verify::Signature::decode(&text)?;
    minisign_verify::PublicKey::from_base64(PUBLIC_KEY)?
        .verify(bytes, &signature, false)
        .context("Подпись обновления не прошла проверку")?;
    Ok(signature.trusted_comment().to_string())
}
#[derive(Debug)]
pub struct Prepared {
    pub directory: PathBuf,
    pub version: String,
}
pub async fn prepare(release: Release, progress: impl Fn(u64, u64)) -> Result<Prepared> {
    release.validate()?;
    ensure!(
        semver::Version::parse(&release.version)?
            > semver::Version::parse(env!("CARGO_PKG_VERSION"))?,
        "Обновление не новее текущей версии"
    );
    let response = http()?
        .get(&release.bundle()?.url)
        .send()
        .await?
        .error_for_status()?;
    let bytes = bounded(response, MAX_DOWNLOAD, progress).await?;
    let comment = verify(&bytes, &release.bundle()?.signature)?;
    ensure!(
        comment == format!("Startrack native {} {}", release.version, platform()),
        "Версия или платформа не совпадает с подписанным обновлением"
    );
    tokio::task::spawn_blocking(move || stage(bytes, &release.version)).await?
}
fn stage(bytes: Vec<u8>, version: &str) -> Result<Prepared> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let install = exe.parent().context("Не найдена папка приложения")?;
    #[cfg(windows)]
    ensure!(
        install.join(".native-bundle").is_file(),
        "Для обновлений запустите переносимую сборку из распакованного архива"
    );
    let parent = install.parent().context("Нет родительской папки")?;
    let name = format!(
        ".startrack-update-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    );
    let dir = parent.join(name);
    std::fs::create_dir(&dir).context(
        "Нет доступа на запись рядом с приложением. Перенесите Startrack в доступную папку",
    )?;
    let result = (|| {
        if cfg!(windows) {
            extract(&bytes, &dir)?;
            ensure!(
                dir.join("startrack.exe").is_file() && dir.join(".native-bundle").is_file(),
                "В архиве нет нативного приложения"
            );
            ensure!(
                std::fs::read_to_string(dir.join(".native-bundle"))?.trim() == version,
                "В архиве другая версия приложения"
            );
            ensure!(
                dir.join("gtk-4-1.dll").is_file() || dir.join("gtk-4.dll").is_file(),
                "В обновлении нет GTK"
            );
        } else {
            std::fs::write(dir.join("startrack"), bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    dir.join("startrack"),
                    std::fs::Permissions::from_mode(0o755),
                )?;
            }
        }
        Ok(Prepared {
            directory: dir.clone(),
            version: version.to_string(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}
fn extract(bytes: &[u8], dir: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    ensure!(archive.len() <= 10_000, "В архиве слишком много файлов");
    let mut size = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        size += entry.size();
        ensure!(
            size <= 600 * 1024 * 1024,
            "Распакованное обновление слишком большое"
        );
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "Архив содержит символьную ссылку"
        );
        let relative = entry
            .enclosed_name()
            .context("Архив содержит путь за пределами папки")?;
        ensure!(!relative.as_os_str().is_empty(), "Пустой путь в архиве");
        let dest = dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dest)?;
            std::io::copy(&mut entry, &mut file)?;
        }
    }
    Ok(())
}
pub fn install(prepared: &Prepared) -> Result<()> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let install = exe.parent().context("Нет папки приложения")?;
    let staged = prepared.directory.canonicalize()?;
    ensure!(
        staged.parent() == install.parent()
            && staged
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(".startrack-update-")),
        "Недопустимая папка обновления"
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let quoted = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
        let backup = install.with_file_name(format!(
            ".startrack-backup-{}",
            chrono::Utc::now().timestamp_millis()
        ));
        let helper = crate::config::directory().join("install-native-update.ps1");
        std::fs::create_dir_all(crate::config::directory())?;
        // All paths are fixed and verified before the helper can rename a directory.
        let script = format!(
            r#"$ErrorActionPreference='Stop'
$target={target}
$stage={stage}
$backup={backup}
Wait-Process -Id {pid} -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
try {{
    if (!(Test-Path -LiteralPath (Join-Path $target '.native-bundle'))) {{ throw 'Invalid installation' }}
    if (!(Test-Path -LiteralPath (Join-Path $stage '.native-bundle'))) {{ throw 'Invalid update' }}
    Move-Item -LiteralPath $target -Destination $backup
    try {{ Move-Item -LiteralPath $stage -Destination $target }}
    catch {{ Move-Item -LiteralPath $backup -Destination $target; throw }}
    Start-Process -FilePath (Join-Path $target 'startrack.exe') -WorkingDirectory $target -WindowStyle Hidden
}} catch {{
    $_ | Out-File -LiteralPath {log} -Encoding utf8
    if (Test-Path -LiteralPath (Join-Path $target 'startrack.exe')) {{ Start-Process -FilePath (Join-Path $target 'startrack.exe') -WindowStyle Hidden }}
}}
"#,
            target = quoted(install),
            stage = quoted(&staged),
            backup = quoted(&backup),
            pid = std::process::id(),
            log = quoted(&crate::config::directory().join("update-error.log"))
        );
        // Windows PowerShell 5 uses the UTF-8 BOM to recognize non-ASCII paths.
        std::fs::write(&helper, format!("\u{feff}{script}"))?;
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&helper)
            .current_dir(crate::config::directory())
            .creation_flags(0x08000000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
    }
    #[cfg(not(windows))]
    {
        let backup = install.join(format!("startrack-{}.backup", env!("CARGO_PKG_VERSION")));
        ensure!(
            !backup.exists(),
            "Резервная копия уже существует: {}",
            backup.display()
        );
        std::fs::rename(&exe, &backup)?;
        if let Err(e) = std::fs::rename(staged.join("startrack"), &exe) {
            let _ = std::fs::rename(&backup, &exe);
            anyhow::bail!(e);
        }
        if let Err(e) = std::process::Command::new(&exe).spawn() {
            let _ = std::fs::rename(&exe, staged.join("startrack"));
            let _ = std::fs::rename(backup, &exe);
            anyhow::bail!(e);
        }
        let _ = std::fs::remove_dir(staged);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_signature_and_zip_traversal() {
        assert!(verify(b"fake executable", "invalid").is_err());
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = Cursor::new(vec![]);
        {
            let mut zip = zip::ZipWriter::new(&mut bytes);
            zip.start_file("../escaped.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut zip, b"bad").unwrap();
            zip.finish().unwrap();
        }
        assert!(extract(bytes.get_ref(), dir.path()).is_err());
        assert!(!dir.path().parent().unwrap().join("escaped.exe").exists());
        let r = Release {
            version: "0.1.32".into(),
            notes: String::new(),
            platforms: [(
                platform().into(),
                Bundle {
                    url: "https://example.com/program.exe".into(),
                    signature: String::new(),
                },
            )]
            .into(),
        };
        assert!(r.validate().is_err());
    }
}
