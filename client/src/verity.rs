//! Native tools for Verity. Approval is handled by GTK before reaching this module.
use serde_json::Value;
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
const MAX_OUT: usize = 16_000;
const MAX_READ: usize = 60_000;
thread_local! { static CANCEL: std::cell::RefCell<Arc<AtomicBool>> = std::cell::RefCell::new(Arc::new(AtomicBool::new(false))); }
fn cancelled() -> bool {
    CANCEL.with(|c| c.borrow().load(Ordering::Relaxed))
}
pub fn workspace() -> PathBuf {
    let user = directories::UserDirs::new();
    user.as_ref()
        .and_then(|u| u.document_dir())
        .or_else(|| user.as_ref().map(|u| u.home_dir()))
        .unwrap_or_else(|| Path::new("."))
        .join("Verity")
}
fn resolve(ws: &Path, input: &str) -> PathBuf {
    let input = input.trim().trim_matches('"');
    let raw = if input == "~" || input.starts_with("~/") || input.starts_with("~\\") {
        directories::BaseDirs::new()
            .map(|d| {
                d.home_dir()
                    .join(input[1..].trim_start_matches(['/', '\\']))
            })
            .unwrap_or_default()
    } else {
        let p = PathBuf::from(input);
        if p.is_absolute() {
            p
        } else {
            ws.join(p)
        }
    };
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}
// Resolve the nearest existing ancestor, so symlinks and junctions cannot grant workspace access.
fn real_path(p: &Path) -> std::io::Result<PathBuf> {
    if p.exists() {
        return p.canonicalize();
    }
    let parent = p
        .parent()
        .ok_or_else(|| std::io::Error::other("Путь не найден"))?;
    Ok(real_path(parent)?.join(
        p.file_name()
            .ok_or_else(|| std::io::Error::other("Недопустимый путь"))?,
    ))
}
fn inside(ws: &Path, p: &Path) -> bool {
    match (real_path(ws), real_path(p)) {
        (Ok(w), Ok(p)) => p.starts_with(w),
        _ => false,
    }
}
fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args[key].as_str().unwrap_or("")
}
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.into()
    } else {
        format!(
            "{}\n… (вывод сокращён)",
            s.chars().take(max).collect::<String>()
        )
    }
}
pub fn describe(name: &str, args: &Value) -> Result<(String, bool), String> {
    let ws = workspace();
    describe_at(&ws, name, args)
}
fn describe_at(ws: &Path, name: &str, args: &Value) -> Result<(String, bool), String> {
    std::fs::create_dir_all(ws).map_err(|e| e.to_string())?;
    let p = resolve(ws, arg(args, "path"));
    Ok(match name {
        "list_dir" => (
            format!("Посмотреть папку:\n{}", p.display()),
            !inside(ws, &p),
        ),
        "read_file" => (format!("Прочитать файл:\n{}", p.display()), !inside(ws, &p)),
        "write_file" => (
            format!(
                "Записать файл:\n{}\n\n{}",
                p.display(),
                cut(arg(args, "content"), 2000)
            ),
            !inside(ws, &p),
        ),
        "edit_file" => (
            format!(
                "Изменить файл:\n{}\n\nЗаменить:\n{}\n\nНа:\n{}",
                p.display(),
                cut(arg(args, "old"), 1000),
                cut(arg(args, "new"), 1000)
            ),
            !inside(ws, &p),
        ),
        "run_command" => (
            format!(
                "Выполнить команду:\n{}\n\nПапка: {}",
                cut(arg(args, "command"), 4000),
                resolve(ws, arg(args, "cwd")).display()
            ),
            true,
        ),
        "open" => (
            format!(
                "Открыть / запустить:\n{} {}",
                arg(args, "target"),
                arg(args, "args")
            ),
            true,
        ),
        "run_code" => (
            format!(
                "Запустить код ({}):\n{}",
                arg(args, "lang"),
                cut(arg(args, "code"), 6000)
            ),
            true,
        ),
        _ => return Err(format!("Неизвестный инструмент {name}")),
    })
}
pub fn execute(
    name: &str,
    args: &Value,
    approved: bool,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    CANCEL.with(|c| *c.borrow_mut() = cancel);
    if cancelled() {
        return Err("Действие остановлено".into());
    }
    let (_, risky) = describe(name, args)?;
    if risky && !approved {
        return Err("Действие требует разрешения".into());
    }
    let ws = workspace();
    run_tool(&ws, name, args)
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
                    (
                        md.as_ref().is_some_and(|m| m.is_dir()),
                        e.file_name().to_string_lossy().into_owned(),
                        md.map_or(0, |m| m.len()),
                    )
                })
                .collect();
            rows.sort_by(|x, y| {
                y.0.cmp(&x.0)
                    .then(x.1.to_lowercase().cmp(&y.1.to_lowercase()))
            });
            let total = rows.len();
            let mut out = format!("{} ({} шт.)\n", p.display(), total);
            for (dir, n, size) in rows.into_iter().take(400) {
                out += &if dir {
                    format!("[папка] {n}\n")
                } else {
                    format!("{n}  ({})\n", human(size))
                };
            }
            if total > 400 {
                out += &format!("… и ещё {}\n", total - 400);
            }
            Ok(out)
        }
        "read_file" => {
            let p = path();
            let f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
            if f.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
                return Err("Файл больше 8 МБ".into());
            }
            let mut bytes = Vec::new();
            f.take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("Файл больше 8 МБ".into());
            }
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return Ok(format!(
                    "{} — двоичный файл, {}",
                    p.display(),
                    human(bytes.len() as u64)
                ));
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
                out += &format!(
                    "… всего строк: {}, показаны {from}–{shown_to}\n",
                    lines.len()
                );
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
            Ok(format!(
                "Записано: {} ({})",
                p.display(),
                human(c.len() as u64)
            ))
        }
        "edit_file" => {
            let p = path();
            if std::fs::metadata(&p).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
                return Err("Файл больше 8 МБ".into());
            }
            let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            let (old, new) = (arg(a, "old"), arg(a, "new"));
            let n = if old.is_empty() {
                0
            } else {
                text.matches(old).count()
            };
            let all = a.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
            if n == 0 {
                return Err(
                    "Фрагмент для замены не найден в файле (old должен совпадать до символа)"
                        .into(),
                );
            }
            if n > 1 && !all {
                return Err(format!(
                    "Фрагмент встречается {n} раз — уточни его или передай all=true"
                ));
            }
            let out = if all {
                text.replace(old, new)
            } else {
                text.replacen(old, new, 1)
            };
            std::fs::write(&p, out).map_err(|e| e.to_string())?;
            Ok(format!(
                "Изменено: {} (замен: {})",
                p.display(),
                if all { n } else { 1 }
            ))
        }
        "run_command" => {
            let cwd = if arg(a, "cwd").is_empty() {
                ws.to_path_buf()
            } else {
                resolve(ws, arg(a, "cwd"))
            };
            let secs = a
                .get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(60)
                .clamp(1, 600);
            shell(arg(a, "command"), &cwd, secs)
        }
        "open" => open(arg(a, "target"), arg(a, "args"), ws),
        "run_code" => run_code(
            ws,
            arg(a, "lang"),
            arg(a, "code"),
            a.get("terminal").and_then(|v| v.as_bool()).unwrap_or(false),
        ),
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
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &b64(&utf16),
        ]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new(if Path::new("/bin/bash").exists() {
            "/bin/bash"
        } else {
            "/bin/sh"
        });
        c.args(["-c", command]);
        use std::os::unix::process::CommandExt;
        c.process_group(0);
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
    let mut child = c
        .spawn()
        .map_err(|e| format!("не удалось запустить оболочку: {e}"))?;
    let grab = |r: Option<Box<dyn Read + Send>>| {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let b = buf.clone();
        let h = std::thread::spawn(move || {
            if let Some(mut r) = r {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let mut v = b.lock().unwrap();
                    if v.len() < 4_000_000 {
                        v.extend_from_slice(&chunk[..n]);
                    }
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
        if cancelled() || start.elapsed() > Duration::from_secs(secs) {
            timed_out = true;
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    while (!ho.is_finished() || !he.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let o = String::from_utf8_lossy(&out.lock().unwrap())
        .trim_end()
        .to_string();
    let e = String::from_utf8_lossy(&err.lock().unwrap())
        .trim_end()
        .to_string();
    let mut res = match status {
        Some(s) => format!("Код выхода: {}\n", s.code().map_or("?".into(), |c| c.to_string())),
        None => format!("Остановлено: команда работала дольше {secs} с (программы с окном и серверы запускай через open)\n"),
    };
    if !o.is_empty() {
        res += &format!("--- вывод ---\n{}\n", cut(&o, MAX_OUT));
    }
    if !e.is_empty() {
        res += &format!("--- ошибки ---\n{}\n", cut(&e, MAX_OUT / 2));
    }
    if o.is_empty() && e.is_empty() && !timed_out {
        res += "(вывода нет)\n";
    }
    Ok(res)
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(0x0800_0000)
            .output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

// одинарные кавычки PowerShell / sh
fn q(s: &str) -> String {
    if cfg!(windows) {
        format!("'{}'", s.replace('\'', "''"))
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

// Программа, файл, папка или ссылка — открывается отдельно, мы не ждём её завершения
fn open(target: &str, args: &str, ws: &Path) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("не указано, что открыть".into());
    }
    #[cfg(windows)]
    let cmd = {
        let mut c = format!("Start-Process -WindowStyle Hidden -FilePath {}", q(target));
        if !args.trim().is_empty() {
            c += &format!(" -ArgumentList {}", q(args));
        }
        c
    };
    #[cfg(not(windows))]
    let cmd = if target.contains("://") || target.contains('/') {
        format!("xdg-open {} >/dev/null 2>&1 &", q(target))
    } else {
        format!("nohup {} {} >/dev/null 2>&1 &", q(target), q(args))
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
        "python" | "py" | "python3" => ("py", |p| {
            if cfg!(windows) {
                format!("python -X utf8 {}", q(p))
            } else {
                format!("python3 {}", q(p))
            }
        }),
        "js" | "javascript" | "node" | "mjs" => ("mjs", |p| format!("node {}", q(p))),
        "ps1" | "powershell" | "pwsh" => ("ps1", |p| format!("& {}", q(p))),
        "bat" | "cmd" | "batch" => ("bat", |p| format!("cmd /c {}", q(p))),
        "sh" | "bash" | "shell" | "zsh" => ("sh", |p| format!("bash {}", q(p))),
        "html" | "htm" => ("html", |_| String::new()),
        _ => return Err(format!("не знаю, как запустить «{lang}»")),
    };
    let dir = ws.join("snippets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
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
            let inner = format!(
                "Set-Location {}; {cmd}; Write-Host ''; Write-Host 'Готово. Окно можно закрыть.'",
                q(&ws.to_string_lossy())
            );
            let utf16: Vec<u8> = inner.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            let r = shell(&format!("Start-Process -WindowStyle Normal powershell -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{}'", b64(&utf16)), ws, 20)?;
            if r.contains("--- ошибки ---") {
                return Err(r);
            }
            return Ok(format!("Запущено в отдельном окне: {fp}"));
        }
        #[cfg(not(windows))]
        return shell(
            &format!(
                "x-terminal-emulator -e bash -c {} >/dev/null 2>&1 &",
                q(&format!("{cmd}; read -p 'Готово. Enter — закрыть'"))
            ),
            ws,
            20,
        );
    }
    let out = shell(&cmd, ws, 120)?;
    Ok(format!("Файл: {fp}\n{out}"))
}

#[cfg(windows)]
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for ch in data.chunks(3) {
        let n = (ch[0] as u32) << 16
            | (*ch.get(1).unwrap_or(&0) as u32) << 8
            | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn workspace_boundaries_tools_and_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let ws = temp.path().join("Verity");
        std::fs::create_dir(&ws).unwrap();
        assert!(
            !describe_at(
                &ws,
                "write_file",
                &json!({"path":"project/note.txt","content":"hello"})
            )
            .unwrap()
            .1
        );
        assert!(
            describe_at(
                &ws,
                "read_file",
                &json!({"path":"../Verity-other/secret.txt"})
            )
            .unwrap()
            .1
        );
        assert!(
            describe_at(&ws, "read_file", &json!({"path":"../../secret.txt"}))
                .unwrap()
                .1
        );
        assert!(
            describe_at(&ws, "run_command", &json!({"command":"echo hi"}))
                .unwrap()
                .1
        );
        assert!(describe_at(&ws, "unknown", &json!({})).is_err());
        run_tool(
            &ws,
            "write_file",
            &json!({"path":"project/note.txt","content":"hello\nhello"}),
        )
        .unwrap();
        assert!(run_tool(
            &ws,
            "edit_file",
            &json!({"path":"project/note.txt","old":"hello","new":"bye"})
        )
        .is_err());
        run_tool(
            &ws,
            "edit_file",
            &json!({"path":"project/note.txt","old":"hello","new":"bye","all":true}),
        )
        .unwrap();
        assert!(
            run_tool(&ws, "read_file", &json!({"path":"project/note.txt"}))
                .unwrap()
                .contains("bye")
        );
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, ws.join("link")).unwrap();
            assert!(!inside(&ws, &ws.join("link/file.txt")));
        }
        let cancelled_flag = Arc::new(AtomicBool::new(false));
        let flag = cancelled_flag.clone();
        CANCEL.with(|c| *c.borrow_mut() = flag);
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            cancelled_flag.store(true, Ordering::Relaxed);
        });
        let now = Instant::now();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 10"
        } else {
            "sleep 10"
        };
        let output = shell(command, &ws, 15).unwrap();
        stopper.join().unwrap();
        assert!(now.elapsed() < Duration::from_secs(5));
        assert!(output.contains("Остановлено"));
        CANCEL.with(|c| *c.borrow_mut() = Arc::new(AtomicBool::new(false)));
    }
}
