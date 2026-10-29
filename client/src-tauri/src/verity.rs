// Руки Верити на компьютере: файлы, команды, запуск программ и кода.
// Нейросеть живёт на сервере и только просит действие — выполняет его этот модуль.
// Разрешение спрашиваем нативным окном Windows, а не кнопкой в HTML: окно не подделать
// из страницы, даже если в мессенджере найдётся XSS.
//
// Режим доступа (хранится в файле настроек приложения):
//   off  — ничего не выполняем;
//   ask  — свою рабочую папку (Документы/Verity) Верити читает и пишет сам,
//          всё остальное (чтение снаружи, команды, программы, код) — только после «Разрешить»;
//   auto — без вопросов (включается тоже через нативное подтверждение).

use serde_json::Value;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const MAX_OUT: usize = 16_000; // символов вывода команды (голова + хвост)
const MAX_READ: usize = 60_000; // символов при чтении файла

#[derive(Default)]
pub struct State {
    mode: Mutex<Option<String>>,
    turn: Mutex<String>, // ответ, на время которого нажали «Разрешить всё»
}

fn mode_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("verity-pc.txt"))
}

fn mode(app: &tauri::AppHandle) -> String {
    let st = app.state::<State>();
    let mut m = st.mode.lock().unwrap();
    if m.is_none() {
        let saved = mode_file(app).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
        *m = Some(match saved.trim() {
            "off" | "auto" => saved.trim().to_string(),
            _ => "ask".to_string(),
        });
    }
    m.clone().unwrap()
}

fn workspace(app: &tauri::AppHandle) -> PathBuf {
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).unwrap_or_else(|_| PathBuf::from("."));
    let dir = base.join("Verity");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub fn verity_pc(app: tauri::AppHandle) -> Value {
    serde_json::json!({ "mode": mode(&app), "workspace": workspace(&app).to_string_lossy() })
}

// Смена режима; «без вопросов» включаем только после нативного подтверждения
#[tauri::command]
pub async fn verity_set_mode(app: tauri::AppHandle, mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "off" | "ask" | "auto") {
        return Err("bad mode".into());
    }
    if mode == "auto" {
        let a = app.clone();
        let ok = tauri::async_runtime::spawn_blocking(move || {
            dialog(&a, "Верити: полный доступ",
                "Разрешить Верити выполнять команды, запускать программы и менять файлы на этом компьютере БЕЗ вопросов?\n\nОн будет делать это только по твоим просьбам, но подтверждать каждое действие ты уже не будешь. Выключить можно в Настройках.",
                MessageDialogButtons::OkCancelCustom("Разрешить без вопросов".into(), "Отмена".into()), MessageDialogKind::Warning)
        }).await.map_err(|e| e.to_string())?;
        if !matches!(ok, MessageDialogResult::Ok | MessageDialogResult::Yes) && ok != MessageDialogResult::Custom("Разрешить без вопросов".into()) {
            return Ok(self::mode(&app));
        }
    }
    if let Some(f) = mode_file(&app) {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, &mode);
    }
    *app.state::<State>().mode.lock().unwrap() = Some(mode.clone());
    Ok(mode)
}

fn dialog(app: &tauri::AppHandle, title: &str, text: &str, buttons: MessageDialogButtons, kind: MessageDialogKind) -> MessageDialogResult {
    let mut d = app.dialog().message(text).title(title).kind(kind).buttons(buttons);
    if let Some(w) = app.get_webview_window("main") {
        d = d.parent(&w);
    }
    d.blocking_show_with_result()
}

// путь без обращения к диску: «..» и «.» схлопываем, относительный — от рабочей папки
fn resolve(ws: &Path, p: &str) -> PathBuf {
    let p = p.trim().trim_matches('"');
    let raw = if let Some(rest) = p.strip_prefix("~") {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(rest.trim_start_matches(['/', '\\']))
    } else {
        let pb = PathBuf::from(p);
        if pb.is_absolute() { pb } else { ws.join(pb) }
    };
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

fn inside(ws: &Path, p: &Path) -> bool {
    let low = |x: &Path| x.to_string_lossy().to_lowercase().replace('/', "\\");
    if cfg!(windows) { low(p).starts_with(&low(ws)) } else { p.starts_with(ws) }
}

fn cut(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max * 2 / 3).collect();
    let tail: String = s.chars().skip(n - max / 3).collect();
    format!("{head}\n… (пропущено {} символов) …\n{tail}", n - max)
}

fn arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

// Что показать человеку в окне разрешения и нужно ли вообще спрашивать
fn describe(ws: &Path, name: &str, a: &Value) -> Result<(String, bool), String> {
    let path = || resolve(ws, arg(a, "path"));
    Ok(match name {
        "list_dir" => { let p = path(); (format!("Посмотреть папку:\n{}", p.display()), !inside(ws, &p)) }
        "read_file" => { let p = path(); (format!("Прочитать файл:\n{}", p.display()), !inside(ws, &p)) }
        "write_file" => {
            let p = path();
            (format!("Записать файл ({} байт):\n{}", arg(a, "content").len(), p.display()), !inside(ws, &p))
        }
        "edit_file" => {
            let p = path();
            (format!("Изменить файл:\n{}\n\nЗаменить:\n{}\n\nНа:\n{}", p.display(), cut(arg(a, "old"), 400), cut(arg(a, "new"), 400)), !inside(ws, &p))
        }
        "run_command" => (format!("Выполнить команду:\n\n{}", cut(arg(a, "command"), 900)), true),
        "open" => (format!("Открыть / запустить:\n{} {}", arg(a, "target"), arg(a, "args")), true),
        "run_code" => (format!("Запустить код ({}):\n\n{}", arg(a, "lang"), cut(arg(a, "code"), 700)), true),
        _ => return Err(format!("неизвестный инструмент {name}")),
    })
}

#[tauri::command]
pub async fn verity_tool(app: tauri::AppHandle, name: String, args: Value, turn: Option<String>) -> Result<String, String> {
    let m = mode(&app);
    if m == "off" {
        return Err("Доступ к компьютеру выключен в настройках Startrack".into());
    }
    let ws = workspace(&app);
    let (what, risky) = describe(&ws, &name, &args)?;
    let turn = turn.unwrap_or_default();
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = a2.state::<State>();
        let all = !turn.is_empty() && *st.turn.lock().unwrap() == turn;
        if risky && m == "ask" && !all {
            let r = dialog(&a2, "Верити просит разрешения", &what,
                MessageDialogButtons::YesNoCancelCustom("Разрешить".into(), "Разрешить всё в этом ответе".into(), "Запретить".into()),
                MessageDialogKind::Info);
            match r {
                MessageDialogResult::Yes => {}
                MessageDialogResult::Custom(ref s) if s == "Разрешить" => {}
                MessageDialogResult::No => *st.turn.lock().unwrap() = turn.clone(),
                MessageDialogResult::Custom(ref s) if s.starts_with("Разрешить всё") => *st.turn.lock().unwrap() = turn.clone(),
                _ => return Err("Пользователь запретил это действие".to_string()),
            }
        }
        run_tool(&ws, &name, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_tool(ws: &Path, name: &str, a: &Value) -> Result<String, String> {
    let path = || resolve(ws, arg(a, "path"));
    match name {
        "list_dir" => {
            let p = path();
            let mut rows: Vec<(bool, String, u64)> = std::fs::read_dir(&p)
                .map_err(|e| format!("{}: {e}", p.display()))?
                .filter_map(|e| e.ok())
                .map(|e| {
                    let md = e.metadata().ok();
                    (md.as_ref().is_some_and(|m| m.is_dir()), e.file_name().to_string_lossy().into_owned(), md.map_or(0, |m| m.len()))
                })
                .collect();
            rows.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.to_lowercase().cmp(&y.1.to_lowercase())));
            let total = rows.len();
            let mut out = format!("{} ({} шт.)\n", p.display(), total);
            for (dir, n, size) in rows.into_iter().take(400) {
                out += &if dir { format!("[папка] {n}\n") } else { format!("{n}  ({})\n", human(size)) };
            }
            if total > 400 {
                out += &format!("… и ещё {}\n", total - 400);
            }
            Ok(out)
        }
        "read_file" => {
            let p = path();
            let bytes = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return Ok(format!("{} — двоичный файл, {}", p.display(), human(bytes.len() as u64)));
            }
            let text = String::from_utf8_lossy(&bytes);
            let from = a.get("offset").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;
            let limit = a.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
            let lines: Vec<&str> = text.lines().collect();
            let mut out = String::new();
            for (i, l) in lines.iter().enumerate().skip(from - 1).take(limit) {
                out += &format!("{:>5}\t{l}\n", i + 1);
                if out.len() > MAX_READ * 2 {
                    break;
                }
            }
            let shown_to = (from - 1 + limit).min(lines.len());
            if shown_to < lines.len() {
                out += &format!("… всего строк: {}, показаны {from}–{shown_to}\n", lines.len());
            }
            Ok(cut(&out, MAX_READ))
        }
        "write_file" => {
            let p = path();
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let c = arg(a, "content");
            std::fs::write(&p, c).map_err(|e| format!("{}: {e}", p.display()))?;
            Ok(format!("Записано: {} ({})", p.display(), human(c.len() as u64)))
        }
        "edit_file" => {
            let p = path();
            let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            let (old, new) = (arg(a, "old"), arg(a, "new"));
            let n = if old.is_empty() { 0 } else { text.matches(old).count() };
            let all = a.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
            if n == 0 {
                return Err("Фрагмент для замены не найден в файле (old должен совпадать до символа)".into());
            }
            if n > 1 && !all {
                return Err(format!("Фрагмент встречается {n} раз — уточни его или передай all=true"));
            }
            let out = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
            std::fs::write(&p, out).map_err(|e| e.to_string())?;
            Ok(format!("Изменено: {} (замен: {})", p.display(), if all { n } else { 1 }))
        }
        "run_command" => {
            let cwd = if arg(a, "cwd").is_empty() { ws.to_path_buf() } else { resolve(ws, arg(a, "cwd")) };
            let secs = a.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60).clamp(1, 600);
            shell(arg(a, "command"), &cwd, secs)
        }
        "open" => open(arg(a, "target"), arg(a, "args"), ws),
        "run_code" => run_code(ws, arg(a, "lang"), arg(a, "code"), a.get("terminal").and_then(|v| v.as_bool()).unwrap_or(false)),
        _ => Err(format!("неизвестный инструмент {name}")),
    }
}

fn human(n: u64) -> String {
    match n {
        n if n >= 1 << 30 => format!("{:.1} ГБ", n as f64 / (1u64 << 30) as f64),
        n if n >= 1 << 20 => format!("{:.1} МБ", n as f64 / (1u64 << 20) as f64),
        n if n >= 1 << 10 => format!("{:.1} КБ", n as f64 / 1024.0),
        n => format!("{n} Б"),
    }
}

// PowerShell (Windows) или sh (Linux); команда уходит base64-ом, чтобы кавычки дошли как есть
fn shell_cmd(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let full = format!("$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;\n{command}");
        let utf16: Vec<u8> = full.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &b64(&utf16)]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new(if Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" });
        c.args(["-c", command]);
        c
    }
}

fn shell(command: &str, cwd: &Path, secs: u64) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("пустая команда".into());
    }
    let mut c = shell_cmd(command);
    c.current_dir(cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("не удалось запустить оболочку: {e}"))?;
    let grab = |r: Option<Box<dyn Read + Send>>| {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let b = buf.clone();
        let h = std::thread::spawn(move || {
            if let Some(mut r) = r {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 { break; }
                    let mut v = b.lock().unwrap();
                    if v.len() < 4_000_000 { v.extend_from_slice(&chunk[..n]); }
                }
            }
        });
        (buf, h)
    };
    let (out, ho) = grab(child.stdout.take().map(|s| Box::new(s) as _));
    let (err, he) = grab(child.stderr.take().map(|s| Box::new(s) as _));
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(s);
        }
        if start.elapsed() > Duration::from_secs(secs) {
            timed_out = true;
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let _ = ho.join();
    let _ = he.join();
    let o = String::from_utf8_lossy(&out.lock().unwrap()).trim_end().to_string();
    let e = String::from_utf8_lossy(&err.lock().unwrap()).trim_end().to_string();
    let mut res = match status {
        Some(s) => format!("Код выхода: {}\n", s.code().map_or("?".into(), |c| c.to_string())),
        None => format!("Остановлено: команда работала дольше {secs} с (программы с окном и серверы запускай через open)\n"),
    };
    if !o.is_empty() { res += &format!("--- вывод ---\n{}\n", cut(&o, MAX_OUT)); }
    if !e.is_empty() { res += &format!("--- ошибки ---\n{}\n", cut(&e, MAX_OUT / 2)); }
    if o.is_empty() && e.is_empty() && !timed_out { res += "(вывода нет)\n"; }
    Ok(res)
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).creation_flags(0x0800_0000).output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

// одинарные кавычки PowerShell / sh
fn q(s: &str) -> String {
    if cfg!(windows) { format!("'{}'", s.replace('\'', "''")) } else { format!("'{}'", s.replace('\'', "'\\''")) }
}

// Программа, файл, папка или ссылка — открывается отдельно, мы не ждём её завершения
fn open(target: &str, args: &str, ws: &Path) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("не указано, что открыть".into());
    }
    #[cfg(windows)]
    let cmd = {
        let mut c = format!("Start-Process -FilePath {}", q(target));
        if !args.trim().is_empty() { c += &format!(" -ArgumentList {}", q(args)); }
        c
    };
    #[cfg(not(windows))]
    let cmd = if target.contains("://") || target.contains('/') {
        format!("xdg-open {} >/dev/null 2>&1 &", q(target))
    } else {
        format!("nohup {} {} >/dev/null 2>&1 &", q(target), args)
    };
    let r = shell(&cmd, ws, 20)?;
    if r.contains("--- ошибки ---") {
        return Err(r);
    }
    Ok(format!("Открыто: {target}"))
}

// Кнопка «Запустить» у блока кода (и инструмент run_code): код — во временный файл и выполнить
fn run_code(ws: &Path, lang: &str, code: &str, terminal: bool) -> Result<String, String> {
    let lang = lang.trim().to_lowercase();
    let (ext, runner): (&str, fn(&str) -> String) = match lang.as_str() {
        "python" | "py" | "python3" => ("py", |p| if cfg!(windows) { format!("python -X utf8 {}", q(p)) } else { format!("python3 {}", q(p)) }),
        "js" | "javascript" | "node" | "mjs" => ("mjs", |p| format!("node {}", q(p))),
        "ps1" | "powershell" | "pwsh" => ("ps1", |p| format!("& {}", q(p))),
        "bat" | "cmd" | "batch" => ("bat", |p| format!("cmd /c {}", q(p))),
        "sh" | "bash" | "shell" | "zsh" => ("sh", |p| format!("bash {}", q(p))),
        "html" | "htm" => ("html", |_| String::new()),
        _ => return Err(format!("не знаю, как запустить «{lang}»")),
    };
    let dir = ws.join("snippets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let file = dir.join(format!("snippet-{stamp}.{ext}"));
    std::fs::write(&file, code).map_err(|e| e.to_string())?;
    let fp = file.to_string_lossy().to_string();
    if ext == "html" {
        return open(&fp, "", ws);
    }
    let cmd = runner(&fp);
    if terminal {
        #[cfg(windows)]
        {
            let inner = format!("Set-Location {}; {cmd}; Write-Host ''; Write-Host 'Готово. Окно можно закрыть.'", q(&ws.to_string_lossy()));
            let utf16: Vec<u8> = inner.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            let r = shell(&format!("Start-Process powershell -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}'", b64(&utf16)), ws, 20)?;
            if r.contains("--- ошибки ---") { return Err(r); }
            return Ok(format!("Запущено в отдельном окне: {fp}"));
        }
        #[cfg(not(windows))]
        return shell(&format!("x-terminal-emulator -e bash -c {} >/dev/null 2>&1 &", q(&format!("{cmd}; read -p 'Готово. Enter — закрыть'"))), ws, 20);
    }
    let out = shell(&cmd, ws, 120)?;
    Ok(format!("Файл: {fp}\n{out}"))
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for ch in data.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() { s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char); } else { s.push('='); }
        }
    }
    s
}
