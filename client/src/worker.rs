use crate::{api::Api, model::Conversation};
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::mpsc::Sender, time::Duration};
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub enum Command {
    CheckUpdate {
        manual: bool,
    },
    DownloadUpdate(crate::update::Release),
    VerityTool {
        turn: String,
        id: String,
        name: String,
        args: Value,
        approved: bool,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    },
    Resume {
        server: String,
        username: String,
    },
    Login {
        server: String,
        username: String,
        password: String,
        register: bool,
    },
    Request {
        tag: String,
        path: String,
        body: Option<Value>,
    },
    Socket(Value),
    Games(bool),
    Upload {
        conv: Conversation,
        file: PathBuf,
    },
    UploadImage {
        kind: String,
        file: PathBuf,
    },
    PrepareImage {
        kind: String,
        file: PathBuf,
    },
    UploadCrop {
        kind: String,
        file: PathBuf,
        crop: crate::crop::Crop,
    },
    Download {
        id: String,
        dest: PathBuf,
    },
    Logout,
    Shutdown,
    Call {
        conv: Conversation,
        accept: bool,
        config: crate::config::Config,
    },
    Media(crate::media::Command),
    Asset(String),
    Ringtone {
        epoch: u64,
    },
    Sound {
        sound: crate::soundboard::Sound,
        epoch: u64,
        preview: bool,
    },
    PreviewSound {
        file: PathBuf,
        start: f32,
        seconds: f32,
        gain: f32,
        epoch: u64,
    },
    UploadSound {
        file: PathBuf,
        start: f32,
        seconds: f32,
        name: String,
        emoji: String,
        gain: f32,
    },
}
#[derive(Debug)]
pub enum Event {
    UpdateChecked {
        manual: bool,
        result: std::result::Result<Option<crate::update::Release>, String>,
    },
    UpdateProgress {
        done: u64,
        total: u64,
    },
    UpdatePrepared(std::result::Result<crate::update::Prepared, String>),
    VerityTool {
        turn: String,
        id: String,
        result: std::result::Result<String, String>,
    },
    ImagePrepared {
        kind: String,
        file: PathBuf,
        preview: crate::images::Preview,
    },
    Login {
        api: ApiInfo,
        user: Box<crate::model::User>,
    },
    Response {
        tag: String,
        data: Value,
    },
    Error {
        tag: String,
        message: String,
    },
    Socket(Value),
    Connected(bool),
    Downloaded(PathBuf),
    Media(crate::media::Event),
    Asset {
        path: String,
        preview: crate::images::Preview,
    },
    Sound {
        epoch: u64,
        preview: bool,
        clip: crate::audio::Clip,
        gain: f32,
    },
    Ringtone {
        epoch: u64,
        clip: crate::audio::Clip,
    },
}
#[derive(Clone, Debug)]
pub struct ApiInfo {
    pub server: String,
    pub token: String,
}

pub fn start(
    events: Sender<Event>,
    frames: crate::media::Frames,
) -> mpsc::UnboundedSender<Command> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Tokio runtime");
        runtime.block_on(async move {
            let mut api: Option<Api> = None;
            let mut credential: Option<keyring::Entry> = None;
            let mut socket_task: Option<tokio::task::JoinHandle<()>> = None;
            let (socket_tx, _) = tokio::sync::broadcast::channel::<Value>(128);
            let (games_tx, _) = tokio::sync::watch::channel(false);
            let media = crate::media::start(events.clone(), frames);
            let mut requests = tokio::task::JoinSet::new();
            while let Some(command) = rx.recv().await {
                match command {
                    Command::CheckUpdate { manual } => {
                        let events = events.clone();
                        tokio::spawn(async move {
                            let result = crate::update::check().await.map_err(|e| format!("{e:#}"));
                            let _ = events.send(Event::UpdateChecked { manual, result });
                        });
                    }
                    Command::DownloadUpdate(release) => {
                        let events = events.clone();
                        tokio::spawn(async move {
                            let last = std::sync::Mutex::new(std::time::Instant::now());
                            let result = crate::update::prepare(release, |done, total| {
                                let mut last = last.lock().unwrap();
                                if last.elapsed() >= Duration::from_millis(150) || done == total {
                                    *last = std::time::Instant::now();
                                    let _ = events.send(Event::UpdateProgress { done, total });
                                }
                            })
                            .await
                            .map_err(|e| format!("{e:#}"));
                            let _ = events.send(Event::UpdatePrepared(result));
                        });
                    }
                    Command::Resume { server, username } => {
                        if let Ok(entry) = keyring::Entry::new(
                            "app.startrack.native",
                            &format!("{}|{}", server.trim_end_matches('/'), username),
                        ) {
                            if let Ok(token) = entry.get_password() {
                                if let Ok(client) = Api::new(&server, token) {
                                    match client.get::<crate::model::User>("/api/me").await {
                                        Ok(user) => {
                                            let _ = events.send(Event::Login {
                                                api: ApiInfo {
                                                    server: client.server.to_string(),
                                                    token: client.token.clone(),
                                                },
                                                user: Box::new(user),
                                            });
                                            socket_task = Some(tokio::spawn(socket(
                                                client.clone(),
                                                events.clone(),
                                                socket_tx.subscribe(),
                                                games_tx.subscribe(),
                                            )));
                                            credential = Some(entry);
                                            api = Some(client);
                                        }
                                        Err(e) => {
                                            let _ = events.send(Event::Error {
                                                tag: "auth".into(),
                                                message: format!("{e:#}"),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Command::Login {
                        server,
                        username,
                        password,
                        register,
                    } => {
                        let result: Result<_> = async {
                            let mut client = Api::new(&server, String::new())?;
                            let r: Value = client
                                .post(
                                    if register {
                                        "/api/register"
                                    } else {
                                        "/api/login"
                                    },
                                    &json!({"username":username,"password":password}),
                                )
                                .await?;
                            client.token = r["token"]
                                .as_str()
                                .ok_or_else(|| anyhow::anyhow!("Нет токена сессии"))?
                                .into();
                            let user = serde_json::from_value(r["user"].clone())?;
                            Ok((client, user))
                        }
                        .await;
                        match result {
                            Ok((client, user)) => {
                                if let Ok(entry) = keyring::Entry::new(
                                    "app.startrack.native",
                                    &format!("{}|{}", server.trim_end_matches('/'), username),
                                ) {
                                    if entry.set_password(&client.token).is_ok() {
                                        credential = Some(entry);
                                    }
                                }
                                if let Some(task) = socket_task.take() {
                                    task.abort();
                                }
                                requests.abort_all();
                                let _ = events.send(Event::Login {
                                    api: ApiInfo {
                                        server: client.server.to_string(),
                                        token: client.token.clone(),
                                    },
                                    user: Box::new(user),
                                });
                                socket_task = Some(tokio::spawn(socket(
                                    client.clone(),
                                    events.clone(),
                                    socket_tx.subscribe(),
                                    games_tx.subscribe(),
                                )));
                                api = Some(client);
                            }
                            Err(e) => {
                                let _ = events.send(Event::Error {
                                    tag: "auth".into(),
                                    message: format!("{e:#}"),
                                });
                            }
                        }
                    }
                    Command::Shutdown => break,
                    Command::Logout => {
                        if let Some(entry) = credential.take() {
                            let _ = entry.delete_credential();
                        }
                        if let Some(task) = socket_task.take() {
                            task.abort();
                        }
                        requests.abort_all();
                        api = None;
                        let _ = media.send(crate::media::Command::Leave);
                        let _ = media.send(crate::media::Command::Mute(false));
                        let _ = media.send(crate::media::Command::Deaf(false));
                    }
                    Command::Socket(value) => {
                        let _ = socket_tx.send(value);
                    }
                    Command::Games(enabled) => {
                        games_tx.send_replace(enabled);
                    }
                    Command::Media(command) => {
                        let _ = media.send(command);
                    }
                    Command::Call {
                        conv,
                        accept,
                        config,
                    } => {
                        if let Some(api) = api.clone() {
                            let _ = media.send(crate::media::Command::Join {
                                api,
                                conv,
                                accept,
                                config: Box::new(config),
                            });
                        }
                    }
                    command => {
                        let Some(api) = api.clone() else { continue };
                        let events = events.clone();
                        requests.spawn(async move {
                            let (tag, result): (String, Result<Value>) = match command {
                                Command::VerityTool {
                                    turn,
                                    id,
                                    name,
                                    args,
                                    approved,
                                    cancel,
                                } => {
                                    let result = tokio::task::spawn_blocking(move || {
                                        crate::verity::execute(&name, &args, approved, cancel)
                                    })
                                    .await
                                    .unwrap_or_else(|e| Err(e.to_string()));
                                    let _ = events.send(Event::VerityTool { turn, id, result });
                                    return;
                                }
                                Command::PrepareImage { kind, file } => {
                                    let input = file.clone();
                                    match tokio::task::spawn_blocking(move || {
                                        crate::images::decode(crate::crop::read(&input)?)
                                    })
                                    .await
                                    {
                                        Ok(Ok(preview)) => {
                                            let _ = events.send(Event::ImagePrepared {
                                                kind,
                                                file,
                                                preview,
                                            });
                                        }
                                        result => {
                                            let _ = events.send(Event::Error {
                                                tag: "image".into(),
                                                message: format!(
                                                    "Не удалось открыть изображение: {result:?}"
                                                ),
                                            });
                                        }
                                    }
                                    return;
                                }
                                Command::UploadCrop { kind, file, crop } => {
                                    let result = async {
                                        let (bytes, mime) =
                                            tokio::task::spawn_blocking(move || {
                                                crate::crop::encode(crate::crop::read(&file)?, crop)
                                            })
                                            .await??;
                                        api.upload_image(&kind, bytes, mime).await
                                    }
                                    .await;
                                    ("me".into(), result)
                                }
                                Command::Ringtone { epoch } => {
                                    let result: Result<_> = async {
                                        let bytes = api
                                            .bytes("/api/ringtone", 15 * 1024 * 1024)
                                            .await
                                            .unwrap_or_else(|_| {
                                                include_bytes!("assets/ringtone.mp3").to_vec()
                                            });
                                        tokio::task::spawn_blocking(move || {
                                            crate::audio::decode_ringtone(bytes)
                                        })
                                        .await?
                                    }
                                    .await;
                                    if let Ok(clip) = result {
                                        let _ = events.send(Event::Ringtone { epoch, clip });
                                    }
                                    return;
                                }
                                Command::Asset(path) => {
                                    let result: Result<_> = async {
                                        let bytes = api.bytes(&path, 25 * 1024 * 1024).await?;
                                        tokio::task::spawn_blocking(move || {
                                            crate::images::decode(bytes)
                                        })
                                        .await?
                                    }
                                    .await;
                                    match result {
                                        Ok(preview) => {
                                            let _ = events.send(Event::Asset { path, preview });
                                        }
                                        Err(e) => {
                                            let _ = events.send(Event::Error {
                                                tag: format!("asset:{path}"),
                                                message: e.to_string(),
                                            });
                                        }
                                    }
                                    return;
                                }
                                Command::Sound {
                                    sound,
                                    epoch,
                                    preview,
                                } => {
                                    let result: Result<_> = async {
                                        anyhow::ensure!(sound.valid(), "Недопустимый звук");
                                        if let Some(clip) = crate::soundboard::synth(&sound.id) {
                                            return Ok(clip);
                                        }
                                        let bytes = api
                                            .bytes(
                                                &format!(
                                                    "/api/sounds/{}",
                                                    sound.file.as_deref().unwrap()
                                                ),
                                                1024 * 1024,
                                            )
                                            .await?;
                                        tokio::task::spawn_blocking(move || {
                                            crate::audio::decode(
                                                bytes,
                                                0.,
                                                crate::audio::MAX_SECONDS,
                                            )
                                        })
                                        .await?
                                    }
                                    .await;
                                    match result {
                                        Ok(clip) => {
                                            let _ = events.send(Event::Sound {
                                                epoch,
                                                preview,
                                                clip,
                                                gain: sound.vol,
                                            });
                                        }
                                        Err(e) => {
                                            let _ = events.send(Event::Error {
                                                tag: "sound".into(),
                                                message: e.to_string(),
                                            });
                                        }
                                    }
                                    return;
                                }
                                Command::PreviewSound {
                                    file,
                                    start,
                                    seconds,
                                    gain,
                                    epoch,
                                } => {
                                    match local_sound(file, start, seconds).await {
                                        Ok(clip) => {
                                            let _ = events.send(Event::Sound {
                                                epoch,
                                                preview: true,
                                                clip,
                                                gain,
                                            });
                                        }
                                        Err(e) => {
                                            let _ = events.send(Event::Error {
                                                tag: "sound".into(),
                                                message: e.to_string(),
                                            });
                                        }
                                    }
                                    return;
                                }
                                Command::UploadSound {
                                    file,
                                    start,
                                    seconds,
                                    name,
                                    emoji,
                                    gain,
                                } => {
                                    let result = async {
                                        let clip = local_sound(file, start, seconds).await?;
                                        api.upload_sound(
                                            &name,
                                            &emoji,
                                            gain,
                                            crate::audio::wav(&clip),
                                        )
                                        .await
                                    }
                                    .await;
                                    ("sound-upload".into(), result)
                                }
                                Command::Request { tag, path, body } => {
                                    let result = if let Some(body) = body {
                                        api.post(&path, &body).await
                                    } else {
                                        api.get(&path).await
                                    };
                                    (tag, result)
                                }
                                Command::Upload { conv, file } => {
                                    let name =
                                        file.file_name().unwrap_or_default().to_string_lossy();
                                    let mut url = api.url("/api/dm/file").unwrap();
                                    for (key, val) in conv.target().as_object().unwrap() {
                                        url.query_pairs_mut().append_pair(key, &val.to_string());
                                    }
                                    url.query_pairs_mut().append_pair("name", &name);
                                    let path = format!(
                                        "{}?{}",
                                        url.path(),
                                        url.query().unwrap_or_default()
                                    );
                                    ("upload".into(), api.upload(&path, &file).await)
                                }
                                Command::UploadImage { kind, file } => {
                                    let path = format!("/api/me/image?kind={kind}");
                                    ("me".into(), api.upload(&path, &file).await)
                                }
                                Command::Download { id, dest } => {
                                    let result = api.download(&id, &dest).await;
                                    if result.is_ok() {
                                        let _ = events.send(Event::Downloaded(dest));
                                    }
                                    ("download".into(), result.map(|_| Value::Null))
                                }
                                _ => return,
                            };
                            match result {
                                Ok(data) => {
                                    let _ = events.send(Event::Response { tag, data });
                                }
                                Err(e) => {
                                    let tag = if e
                                        .downcast_ref::<crate::api::HttpError>()
                                        .is_some_and(|e| e.status == 401)
                                    {
                                        "session".to_string()
                                    } else {
                                        tag
                                    };
                                    let _ = events.send(Event::Error {
                                        tag,
                                        message: format!("{e:#}"),
                                    });
                                }
                            }
                        });
                        while requests.try_join_next().is_some() {}
                    }
                }
            }
            if let Some(task) = socket_task {
                task.abort();
            }
            requests.abort_all();
        });
    });
    tx
}

async fn local_sound(file: PathBuf, start: f32, seconds: f32) -> Result<crate::audio::Clip> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let file = std::fs::File::open(file)?;
        anyhow::ensure!(
            file.metadata()?.len() <= 50 * 1024 * 1024,
            "Выберите звук не больше 50 МБ"
        );
        let mut bytes = vec![];
        file.take(50 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(bytes.len() <= 50 * 1024 * 1024, "Звук слишком большой");
        crate::audio::decode(bytes, start, seconds)
    })
    .await?
}

async fn socket(
    api: Api,
    events: Sender<Event>,
    mut outgoing: tokio::sync::broadcast::Receiver<Value>,
    games: tokio::sync::watch::Receiver<bool>,
) {
    let Ok(url) = api.websocket_url() else { return };
    let mut delay = 1;
    loop {
        let connection = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await;
        if let Ok(Ok((ws, _))) = connection {
            delay = 1;
            let _ = events.send(Event::Connected(true));
            let (mut write, mut read) = ws.split();
            let (game_tx, mut game_rx) = mpsc::channel(2);
            // JoinSet aborts its reporter on logout, shutdown, or reconnect.
            let mut reporters = tokio::task::JoinSet::new();
            reporters.spawn(crate::games::report(games.clone(), game_tx));
            loop {
                tokio::select! {
                    Some(value) = game_rx.recv() => {
                        // Never publish a stale enabled report after the switch was turned off.
                        if value["procs"].is_array() != *games.borrow() { continue; }
                        if write.send(tokio_tungstenite::tungstenite::Message::Text(value.to_string().into())).await.is_err() { break; }
                    },
                    msg = read.next() => match msg {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            if let Ok(value) = serde_json::from_str(&text) { let _ = events.send(Event::Socket(value)); }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(data))) => {
                            if write.send(tokio_tungstenite::tungstenite::Message::Pong(data)).await.is_err() { break; }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(frame))) => {
                            if frame.is_some_and(|f| u16::from(f.code) == 4001) {
                                let _ = events.send(Event::Error { tag:"session".into(), message:"Сессия завершена. Войдите заново.".into() });
                                return;
                            }
                            break;
                        }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    value = outgoing.recv() => match value {
                        Ok(value) => if write.send(tokio_tungstenite::tungstenite::Message::Text(value.to_string().into())).await.is_err() { break; },
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                        Err(_) => {},
                    }
                }
            }
        }
        let _ = events.send(Event::Connected(false));
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(15);
    }
}
