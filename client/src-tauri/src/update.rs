// Автообновление (как в Discord): клиент спрашивает GitHub, есть ли релиз новее (latest.json
// последнего релиза), скачивает установщик, проверяет его подпись и ставит поверх себя.
// Установщик NSIS в режиме passive сам перезапускает приложение после установки.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<Update>>,
    done: AtomicU64,
    total: AtomicU64,
}

/// Есть ли версия новее. Возвращает (версия, описание изменений) или None.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Pending>) -> Result<Option<(String, String)>, String> {
    // проверка короткая: зависшее соединение (бывает через VPN) не должно откладывать следующую попытку
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .header("Cache-Control", "no-cache")
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let mut update = updater.check().await.map_err(|e| e.to_string())?;
    // а на скачивание установщика времени даём много
    if let Some(u) = update.as_mut() {
        u.timeout = Some(Duration::from_secs(600));
    }
    let info = update.as_ref().map(|u| (u.version.clone(), u.body.clone().unwrap_or_default()));
    *state.update.lock().unwrap() = update;
    Ok(info)
}

/// Скачивает и ставит найденное обновление. При успехе процесс завершается и запускается установщик.
#[tauri::command]
pub async fn update_install(state: State<'_, Pending>) -> Result<(), String> {
    let update = state.update.lock().unwrap().take().ok_or("Обновление не найдено")?;
    state.done.store(0, Ordering::Relaxed);
    state.total.store(0, Ordering::Relaxed);
    let result = match update
        .download(
            |chunk, total| {
                state.done.fetch_add(chunk as u64, Ordering::Relaxed);
                state.total.store(total.unwrap_or(0), Ordering::Relaxed);
            },
            || {},
        )
        .await
    {
        Ok(bytes) => update.install(bytes),
        Err(e) => Err(e),
    };
    // сюда попадаем только при ошибке: оставляем обновление, чтобы можно было повторить
    let err = result.err().map(|e| e.to_string()).unwrap_or_default();
    *state.update.lock().unwrap() = Some(update);
    Err(err)
}

/// Сколько байт скачано и сколько всего (0 — неизвестно).
#[tauri::command]
pub fn update_progress(state: State<'_, Pending>) -> (u64, u64) {
    (state.done.load(Ordering::Relaxed), state.total.load(Ordering::Relaxed))
}
