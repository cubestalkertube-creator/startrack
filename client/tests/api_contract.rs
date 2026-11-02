//! Runs against the unchanged Node server with an isolated temporary database.
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use startrack::{
    api::Api,
    model::{Friends, Group, Message, User},
};
use std::{
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Server {
    child: Child,
    _data: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}
async fn start() -> Result<(Server, Api)> {
    let port = free_port()?;
    let admin = free_port()?;
    let data = tempfile::tempdir()?;
    // Tests use synthetic Steam metadata; never fetch the external game catalog.
    std::fs::write(data.path().join("detectable.json"), b"[]")?;
    let child = Command::new("node")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/src/index.js"))
        .env("PORT", port.to_string())
        .env("ADMIN_PORT", admin.to_string())
        .env("DATA_DIR", data.path())
        .env("APP_SECRET", "native-integration-test")
        .env("ADMIN_TOKEN", "")
        .env("POLZA_API_KEY", "")
        .env(
            "LIVEKIT_URL",
            std::env::var("STARTRACK_TEST_LIVEKIT_URL")
                .unwrap_or_else(|_| "ws://127.0.0.1:7880".into()),
        )
        .env("LIVEKIT_API_KEY", "devkey")
        .env("LIVEKIT_API_SECRET", "secret")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Нужен Node.js 24 и npm ci в server/")?;
    let server = Server { child, _data: data };
    let api = Api::new(&format!("http://127.0.0.1:{port}"), String::new())?;
    for _ in 0..60 {
        if api.get::<Value>("/health").await.is_ok() {
            return Ok((server, api));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("Тестовый сервер не запустился; выполните npm ci в server/")
}

#[tokio::test]
#[ignore = "Requires STARTRACK_LIVEKIT_BIN pointing to the official livekit-server binary"]
async fn native_media_round_trip() -> Result<()> {
    use livekit::webrtc::{
        audio_frame::AudioFrame,
        audio_source::{native::NativeAudioSource, RtcAudioSource},
        audio_stream::native::NativeAudioStream,
        prelude::AudioSourceOptions,
        video_frame::{I420Buffer, VideoFrame, VideoRotation},
        video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
        video_stream::native::NativeVideoStream,
    };
    use livekit::{options::TrackPublishOptions, prelude::*, Room, RoomEvent, RoomOptions};
    let port = free_port()?;
    let tcp = free_port()?;
    let udp = free_port()?;
    let data = tempfile::tempdir()?;
    let config = data.path().join("livekit.yaml");
    std::fs::write(&config,format!("port: {port}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: {tcp}\n  udp_port: {udp}\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  devkey: secret\n"))?;
    let child =
        Command::new(std::env::var("STARTRACK_LIVEKIT_BIN").context("STARTRACK_LIVEKIT_BIN")?)
            .arg("--config")
            .arg(&config)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
    let _livekit = Server { child, _data: data };
    for _ in 0..60 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The API is unchanged; only its test media endpoint is configured.
    std::env::set_var(
        "STARTRACK_TEST_LIVEKIT_URL",
        format!("ws://127.0.0.1:{port}"),
    );
    let (_server, api) = start().await?;
    let (alice, a) = register(&api, "media_alice").await?;
    let (bob, b) = register(&api, "media_bob").await?;
    let _: Friends = alice
        .post("/api/friends/request", &json!({"username":b.username}))
        .await?;
    let _: Friends = bob
        .post("/api/friends/accept", &json!({"userId":a.id}))
        .await?;
    let ta: Value = alice.post("/api/call/token", &json!({"peer":b.id})).await?;
    let tb: Value = bob.post("/api/call/token", &json!({"peer":a.id})).await?;
    // Repeated setup/use/teardown exercises the patched native audio bridge lifecycle.
    for cycle in 0..3 {
        eprintln!("media cycle {cycle}: connect");
        let (publisher, _) = Room::connect(
            ta["url"].as_str().unwrap(),
            ta["token"].as_str().unwrap(),
            RoomOptions::default(),
        )
        .await?;
        let (subscriber, mut events) = Room::connect(
            tb["url"].as_str().unwrap(),
            tb["token"].as_str().unwrap(),
            RoomOptions::default(),
        )
        .await?;
        eprintln!("media cycle {cycle}: connected");
        // Legacy clients also use topic `sb` and these exact JSON fields.
        let sound = startrack::soundboard::builtins().remove(5);
        publisher
            .local_participant()
            .publish_data(livekit::DataPacket {
                topic: Some("sb".into()),
                reliable: true,
                payload: serde_json::to_vec(&sound)?,
                ..Default::default()
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if let RoomEvent::DataReceived {
                    payload,
                    topic,
                    participant,
                    ..
                } = event
                {
                    if topic.as_deref() == Some("sb") {
                        assert_eq!(
                            participant.context("sound sender")?.identity().as_str(),
                            a.id.to_string()
                        );
                        let sound: startrack::soundboard::Sound = serde_json::from_slice(&payload)?;
                        assert!(sound.valid());
                        assert_eq!(sound.id, "b:quack");
                        assert!(startrack::soundboard::synth(&sound.id).is_some());
                        return Ok::<_, anyhow::Error>(());
                    }
                }
            }
            anyhow::bail!("Soundboard command not received")
        })
        .await??;
        let audio = NativeAudioSource::new(AudioSourceOptions::default(), 48000, 1, 100);
        let system_audio = NativeAudioSource::new(AudioSourceOptions::default(), 48000, 2, 100);
        let video = NativeVideoSource::new(
            VideoResolution {
                width: 160,
                height: 96,
            },
            true,
        );
        publisher
            .local_participant()
            .publish_track(
                LocalTrack::Audio(LocalAudioTrack::create_audio_track(
                    "synthetic",
                    RtcAudioSource::Native(audio.clone()),
                )),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await?;
        publisher
            .local_participant()
            .publish_track(
                LocalTrack::Video(LocalVideoTrack::create_video_track(
                    "test-screen",
                    RtcVideoSource::Native(video.clone()),
                )),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    ..Default::default()
                },
            )
            .await?;
        publisher
            .local_participant()
            .publish_track(
                LocalTrack::Audio(LocalAudioTrack::create_audio_track(
                    "test-screen-audio",
                    RtcAudioSource::Native(system_audio.clone()),
                )),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    ..Default::default()
                },
            )
            .await?;
        let producer = tokio::spawn(async move {
            for frame in 0..1000 {
                let data: Vec<i16> = (0..480)
                    .map(|i| {
                        (((frame * 480 + i) as f32 * 440. * std::f32::consts::TAU / 48000.).sin()
                            * 8000.) as i16
                    })
                    .collect();
                let _ = audio
                    .capture_frame(&AudioFrame {
                        data: std::borrow::Cow::Owned(data),
                        sample_rate: 48000,
                        num_channels: 1,
                        samples_per_channel: 480,
                    })
                    .await;
                let _ = system_audio
                    .capture_frame(&AudioFrame {
                        data: std::borrow::Cow::Owned(vec![1200; 960]),
                        sample_rate: 48000,
                        num_channels: 2,
                        samples_per_channel: 480,
                    })
                    .await;
                if frame % 3 == 0 {
                    video.capture_frame(&VideoFrame {
                        rotation: VideoRotation::VideoRotation0,
                        timestamp_us: frame * 10000,
                        frame_metadata: None,
                        buffer: I420Buffer::new_black(160, 96),
                    });
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            let mut heard = false;
            let mut heard_system = false;
            let mut saw = false;
            while let Some(event) = events.recv().await {
                if let RoomEvent::TrackSubscribed {
                    track, publication, ..
                } = event
                {
                    match track {
                        RemoteTrack::Audio(track) => {
                        eprintln!("media cycle {cycle}: audio {:?}", publication.source());
                            let rtc = track.rtc_track();
                            let gain = if publication.source() == TrackSource::ScreenshareAudio {
                                1.5
                            } else {
                                0.25
                            };
                            rtc.set_volume(gain);
                        eprintln!("media cycle {cycle}: set gain");
                            assert!((rtc.volume() - gain).abs() < 1e-6);
                            track.disable();
                            assert!(!track.is_enabled());
                            track.enable();
                            assert!((rtc.volume() - gain).abs() < 1e-6);
                            rtc.set_volume(0.);
                            assert_eq!(rtc.volume(), 0.);
                            rtc.set_volume(f64::NAN);
                            assert_eq!(rtc.volume(), 1.);
                            rtc.set_volume(gain);
                            let mut stream = NativeAudioStream::new(track.rtc_track(), 48000, 1);
                            let frame = stream.next().await.context("audio frame")?;
                            assert_eq!(frame.sample_rate, 48000);
                            if publication.source() == TrackSource::ScreenshareAudio {
                                heard_system = true;
                            } else {
                                heard = true;
                            }
                        }
                        RemoteTrack::Video(track) => {
                            let mut stream = NativeVideoStream::new(track.rtc_track());
                            let frame = stream.next().await.context("video frame")?;
                            assert_eq!(frame.buffer.width(), 160);
                            assert_eq!(frame.buffer.height(), 96);
                            saw = true;
                        }
                    }
                }
                if heard && heard_system && saw {
                    return Ok::<_, anyhow::Error>(());
                }
            }
            anyhow::bail!("Room closed before receiving microphone, screen audio and video")
        })
        .await;
        producer.abort();
        eprintln!("media cycle {cycle}: closing");
        publisher.close().await?;
        subscriber.close().await?;
        result??;
        eprintln!("media cycle {cycle}: closed");
    }
    Ok(())
}

type TestSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_game(socket: &mut TestSocket, user: i64) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(frame) = socket.next().await {
            let frame = frame?;
            if frame.is_text() {
                let data: Value = serde_json::from_str(frame.to_text()?)?;
                if data["type"] == "game" && data["userId"] == user {
                    return Ok(data["game"].clone());
                }
            }
        }
        anyhow::bail!("Game socket closed")
    })
    .await?
}

#[tokio::test]
async fn native_game_presence_clear_invisible_and_reconnect() -> Result<()> {
    let (_server, api) = start().await?;
    let (alice, a) = register(&api, "games_alice").await?;
    let (bob, b) = register(&api, "games_bob").await?;
    let _: Friends = alice
        .post("/api/friends/request", &json!({"username":b.username}))
        .await?;
    let _: Friends = bob
        .post("/api/friends/accept", &json!({"userId":a.id}))
        .await?;
    let (mut publisher, _) =
        tokio_tungstenite::connect_async(alice.websocket_url()?.as_str()).await?;
    let (mut observer, _) = tokio_tungstenite::connect_async(bob.websocket_url()?.as_str()).await?;
    let report = json!({"type":"procs", "procs":[startrack::games::Process {
        p: "Games/Native/game.exe".into(),
        t: chrono::Utc::now().timestamp_millis() as u64,
        steam: Some(("1234567890".into(), "Native Fixture Game".into())),
    }]});
    publisher
        .send(tokio_tungstenite::tungstenite::Message::Text(
            report.to_string().into(),
        ))
        .await?;
    assert_eq!(
        next_game(&mut observer, a.id).await?["name"],
        "Native Fixture Game"
    );
    assert_eq!(
        next_game(&mut publisher, a.id).await?["name"],
        "Native Fixture Game"
    );
    let friends: Friends = bob.get("/api/friends").await?;
    assert_eq!(
        friends.friends[0]
            .game
            .as_ref()
            .context("friend's game")?
            .name,
        "Native Fixture Game"
    );
    publisher
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({"type":"procs","procs":null}).to_string().into(),
        ))
        .await?;
    assert!(next_game(&mut observer, a.id).await?.is_null());
    assert!(next_game(&mut publisher, a.id).await?.is_null());
    publisher
        .send(tokio_tungstenite::tungstenite::Message::Text(
            report.to_string().into(),
        ))
        .await?;
    assert!(!next_game(&mut observer, a.id).await?.is_null());
    let _: User = alice
        .post("/api/me/status", &json!({"status":"invisible"}))
        .await?;
    assert!(next_game(&mut observer, a.id).await?.is_null());
    assert!(alice.get::<User>("/api/me").await?.game.is_some());
    let _: User = alice
        .post("/api/me/status", &json!({"status":"online"}))
        .await?;
    assert!(!next_game(&mut observer, a.id).await?.is_null());
    publisher.close(None).await?;
    assert!(next_game(&mut observer, a.id).await?.is_null());
    let (mut publisher, _) =
        tokio_tungstenite::connect_async(alice.websocket_url()?.as_str()).await?;
    publisher
        .send(tokio_tungstenite::tungstenite::Message::Text(
            report.to_string().into(),
        ))
        .await?;
    assert!(!next_game(&mut observer, a.id).await?.is_null());
    publisher.close(None).await?;
    observer.close(None).await?;
    Ok(())
}
async fn register(api: &Api, name: &str) -> Result<(Api, User)> {
    let result: Value = api
        .post(
            "/api/register",
            &json!({"username":name,"password":"test-password-123"}),
        )
        .await?;
    let mut client = api.clone();
    client.token = result["token"].as_str().context("token")?.into();
    Ok((client, serde_json::from_value(result["user"].clone())?))
}

#[tokio::test]
async fn native_client_matches_existing_server_contract() -> Result<()> {
    let (_server, api) = start().await?;
    let (alice, a) = register(&api, "native_alice").await?;
    let (bob, b) = register(&api, "native_bob").await?;
    let me: User = alice.get("/api/me").await?;
    assert_eq!(me.id, a.id);
    let _: Friends = alice
        .post("/api/friends/request", &json!({"username":b.username}))
        .await?;
    let friends: Friends = bob
        .post("/api/friends/accept", &json!({"userId":a.id}))
        .await?;
    assert_eq!(friends.friends[0].id, a.id);
    let (mut ws, _) = tokio_tungstenite::connect_async(bob.websocket_url()?.as_str()).await?;
    let message: Message = alice
        .post(
            "/api/dm/messages",
            &json!({"peer":b.id,"text":"Привет из Rust"}),
        )
        .await?;
    let pushed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(frame)) = ws.next().await {
            if let Ok(text) = frame.into_text() {
                if let Ok(ev) = serde_json::from_str::<Value>(&text) {
                    if ev["type"] == "message" {
                        return ev;
                    }
                }
            }
        }
        Value::Null
    })
    .await?;
    assert_eq!(pushed["msg"]["id"], message.id);
    let history: Vec<Message> = bob.get(&format!("/api/dm/messages?peer={}", a.id)).await?;
    assert_eq!(history[0].text, "Привет из Rust");
    let group: Group = alice
        .post(
            "/api/groups/create",
            &json!({"users":[b.id],"name":"Native"}),
        )
        .await?;
    let gmsg: Message = bob
        .post(
            "/api/group/messages",
            &json!({"group":group.id,"text":"Группа"}),
        )
        .await?;
    assert_eq!(gmsg.grp, Some(group.id));
    let edited: User = alice
        .post(
            "/api/me/profile",
            &json!({"display":"Алиса","bio":"Rust + GTK"}),
        )
        .await?;
    assert_eq!(edited.name(), "Алиса");
    let (avatar, mime) = startrack::crop::encode(
        include_bytes!("../icons/icon.png").to_vec(),
        startrack::crop::Crop::new(false),
    )?;
    let updated: User = serde_json::from_value(alice.upload_image("avatar", avatar, mime).await?)?;
    let stored = alice
        .bytes(&format!("/api/avatars/{}", updated.avatar), 5 * 1024 * 1024)
        .await?;
    let decoded = startrack::images::decode(stored)?;
    assert_eq!((decoded.width, decoded.height), (512, 512));
    let file = tempfile::Builder::new().suffix(".txt").tempfile()?;
    std::fs::write(file.path(), b"native attachment")?;
    let upload: Message = alice
        .upload(
            &format!("/api/dm/file?peer={}&name=native.txt", b.id),
            file.path(),
        )
        .await?;
    let attachment = upload.file.context("attachment")?;
    assert_eq!(attachment.mime, "text/plain");
    let dest = file.path().with_extension("download");
    bob.download(&attachment.id, &dest).await?;
    assert_eq!(std::fs::read(&dest)?, b"native attachment");
    std::fs::remove_file(dest)?;
    assert!(bob
        .post::<Value>("/api/messages/delete", &json!({"id":message.id}))
        .await
        .is_err());
    let _: Value = alice
        .post("/api/messages/delete", &json!({"id":message.id}))
        .await?;
    let _: Friends = alice
        .post("/api/friends/remove", &json!({"userId":b.id}))
        .await?;
    assert!(alice
        .post::<Message>(
            "/api/dm/messages",
            &json!({"peer":b.id,"text":"Недоступно"})
        )
        .await
        .is_err());
    Ok(())
}

#[tokio::test]
async fn soundboard_upload_share_edit_delete_and_permissions() -> Result<()> {
    use startrack::{audio, soundboard};
    let (_server, api) = start().await?;
    let (alice, a) = register(&api, "sound_alice").await?;
    let (bob, b) = register(&api, "sound_bob").await?;
    let list = alice
        .upload_sound(
            "Кря & привет",
            "🦆",
            0.7,
            audio::wav(&soundboard::synth("b:quack").unwrap()),
        )
        .await?;
    let sounds = soundboard::from_server(list);
    assert_eq!(sounds.len(), 1);
    assert_eq!(sounds[0].name, "Кря & привет");
    let id: i64 = sounds[0].id[2..].parse()?;
    let file = sounds[0].file.as_deref().unwrap();
    let bytes = alice
        .bytes(&format!("/api/sounds/{file}"), 1024 * 1024)
        .await?;
    let decoded = audio::decode(bytes, 0., audio::MAX_SECONDS)?;
    assert!(decoded.duration() <= audio::MAX_SECONDS);
    assert!(decoded.samples.iter().any(|s| s.abs() > 0.05));
    let hidden: Value = bob.get(&format!("/api/sounds?users={}", a.id)).await?;
    assert!(hidden.as_array().unwrap().is_empty());
    let _: Friends = alice
        .post("/api/friends/request", &json!({"username":b.username}))
        .await?;
    let _: Friends = bob
        .post("/api/friends/accept", &json!({"userId":a.id}))
        .await?;
    let shared: Value = bob.get(&format!("/api/sounds?users={}", a.id)).await?;
    assert_eq!(soundboard::from_server(shared).len(), 1);
    assert!(bob
        .post::<Value>("/api/sounds/edit", &json!({"id":id,"name":"Чужой","vol":1}))
        .await
        .is_err());
    assert!(bob
        .post::<Value>("/api/sounds/delete", &json!({"id":id}))
        .await
        .is_err());
    let edited: Value = alice
        .post(
            "/api/sounds/edit",
            &json!({"id":id,"name":"Утка","emoji":"🎵","vol":0.3}),
        )
        .await?;
    let edited = soundboard::from_server(edited);
    assert_eq!(edited[0].name, "Утка");
    assert_eq!(edited[0].vol, 0.3);
    let deleted: Value = alice.post("/api/sounds/delete", &json!({"id":id})).await?;
    assert!(deleted.as_array().unwrap().is_empty());
    assert!(alice
        .bytes(&format!("/api/sounds/{file}"), 1024 * 1024)
        .await
        .is_err());
    Ok(())
}
