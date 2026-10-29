// Скачивание вложений из чата: WebView2 без своего окна загрузок кладёт файл в «Загрузки»,
// а клиенту сообщаем, куда сохранили (по клику на уведомление показываем файл в проводнике).
use std::path::{Path, PathBuf};
use tauri::webview::DownloadEvent;
use tauri::{Runtime, Webview};

pub fn on_download<R: Runtime>(wv: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            if destination.is_absolute() {
                *destination = unique(destination);
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            let path = path.map(|p| p.to_string_lossy().into_owned());
            let _ = wv.eval(format!(
                "window.__stDownload?.({}, {success})",
                serde_json::to_string(&path).unwrap_or_else(|_| "null".into())
            ));
        }
        _ => {}
    }
    true
}

// «файл.pdf» уже есть — сохраняем как «файл (1).pdf», ничего не перезаписываем
fn unique(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..)
        .map(|n| path.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Открывает проводник с выделенным файлом.
#[tauri::command]
pub fn reveal_file(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if Path::new(&path).is_file() {
            let _ = std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{path}\""))
                .spawn();
        } else if Path::new(&path).is_dir() {
            // папка (рабочая папка Верити из настроек) — просто открываем её
            let _ = std::process::Command::new("explorer").raw_arg(format!("\"{path}\"")).spawn();
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}
