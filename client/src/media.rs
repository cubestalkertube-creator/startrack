//! Native LiveKit/WebRTC. No browser or JavaScript runtime participates in a call.
use crate::{api::Api, config::Config, model::Conversation, worker::Event as UiEvent};
use anyhow::{bail, Result};
use futures_util::StreamExt;
use livekit::webrtc::{
    audio_frame::AudioFrame,
    audio_source::{native::NativeAudioSource, RtcAudioSource},
    prelude::*,
    video_frame::{I420Buffer, VideoFormatType, VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
    video_stream::native::NativeVideoStream,
};
use livekit::{
    options::TrackPublishOptions, prelude::*, PlatformAudio, Room, RoomEvent, RoomOptions,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
pub type Frames = Arc<Mutex<BTreeMap<String, Frame>>>;

#[derive(Clone)]
pub enum Command {
    Join {
        api: Api,
        conv: Conversation,
        accept: bool,
        config: Box<Config>,
    },
    Leave,
    Mute(bool),
    Deaf(bool),
    Volumes(crate::playback::Playback),
    Screen {
        window: bool,
        id: u32,
        height: u32,
        fps: u32,
        audio: bool,
    },
    CaptureEnded(TrackSid),
    StopScreen,
    Subscribe {
        sid: String,
        enabled: bool,
    },
    MuteUser {
        identity: String,
        muted: bool,
    },
    Data {
        topic: String,
        data: Value,
    },
    Devices,
}
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaCommand")
    }
}
#[derive(Debug)]
pub enum Event {
    Joined {
        conv: Conversation,
        accept: bool,
    },
    Left,
    Participants(Vec<(String, String, bool)>),
    Video {
        key: String,
        identity: String,
        label: String,
    },
    VideoRemoved(String),
    State(String),
    Data {
        topic: String,
        data: Value,
        from: String,
    },
    Devices {
        microphones: Vec<(String, String)>,
        outputs: Vec<(String, String)>,
    },
    Screen(bool),
}

struct Active {
    room: Arc<Room>,
    _audio: PlatformAudio,
    mic: LocalAudioTrack,
    events: tokio::task::JoinHandle<()>,
    screen: Option<Screen>,
}
struct Screen {
    sid: TrackSid,
    stop: Arc<AtomicBool>,
    audio: Option<TrackSid>,
    forward: Option<tokio::task::JoinHandle<()>>,
}

pub fn start(events: Sender<UiEvent>, frames: Frames) -> mpsc::UnboundedSender<Command> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let internal = tx.clone();
    tokio::spawn(async move {
        let mut active: Option<Active> = None;
        let mut muted = false;
        let mut deaf = false;
        let deaf_flag = Arc::new(AtomicBool::new(false));
        let muted_users = Arc::new(Mutex::new(BTreeMap::<String, bool>::new()));
        let playback = Arc::new(Mutex::new(crate::playback::Playback::from_config(
            &Config::default(),
        )));
        while let Some(command) = rx.recv().await {
            let result: Result<()> = async {
                match command {
                    Command::Join {
                        api,
                        conv,
                        accept,
                        config,
                    } => {
                        if active.is_some() {
                            bail!("Вы уже в звонке");
                        }
                        *playback.lock().unwrap() = crate::playback::Playback::from_config(&config);
                        let _ = events.send(UiEvent::Media(Event::State("Подключение…".into())));
                        let token: Value = api.post("/api/call/token", &conv.target()).await?;
                        let audio = PlatformAudio::new()?;
                        audio.configure_audio_processing(livekit::AudioProcessingOptions {
                            echo_cancellation: true,
                            noise_suppression: config.noise_suppression,
                            auto_gain_control: true,
                            prefer_hardware_processing: true,
                        })?;
                        if let Some(d) = audio
                            .recording_devices()
                            .find(|d| d.id.as_str() == config.microphone)
                        {
                            audio.set_recording_device(&d.id)?;
                        }
                        if let Some(d) = audio
                            .playout_devices()
                            .find(|d| d.id.as_str() == config.output)
                        {
                            audio.set_playout_device(&d.id)?;
                        }
                        let mut options = RoomOptions::default();
                        options.adaptive_stream = true;
                        options.dynacast = true;
                        if config.relay {
                            options.rtc_config.ice_transport_type = IceTransportsType::Relay;
                        }
                        let (room, mut stream) = Room::connect(
                            token["url"]
                                .as_str()
                                .ok_or_else(|| anyhow::anyhow!("Нет адреса LiveKit"))?,
                            token["token"]
                                .as_str()
                                .ok_or_else(|| anyhow::anyhow!("Нет токена LiveKit"))?,
                            options,
                        )
                        .await?;
                        let room = Arc::new(room);
                        let mic =
                            LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
                        if muted || deaf {
                            mic.mute();
                        }
                        if let Err(e) = room
                            .local_participant()
                            .publish_track(
                                LocalTrack::Audio(mic.clone()),
                                TrackPublishOptions {
                                    source: TrackSource::Microphone,
                                    ..Default::default()
                                },
                            )
                            .await
                        {
                            let _ = room.close().await;
                            return Err(e.into());
                        }
                        let task_events = events.clone();
                        let room_clone = room.clone();
                        let frame_sink = frames.clone();
                        let deaf_flag = deaf_flag.clone();
                        let muted_users = muted_users.clone();
                        let playback = playback.clone();
                        let task = tokio::spawn(async move {
                            let mut videos = tokio::task::JoinSet::new();
                            while let Some(event) = stream.recv().await {
                                let update = match event {
                                    RoomEvent::TrackSubscribed {
                                        track: RemoteTrack::Audio(track),
                                        participant,
                                        publication,
                                    } => {
                                        track.rtc_track().set_volume(playback.lock().unwrap().gain(
                                            participant.identity().as_str(), publication.source() == TrackSource::ScreenshareAudio));
                                        if deaf_flag.load(Ordering::Relaxed)
                                            || muted_users
                                                .lock()
                                                .unwrap()
                                                .get(participant.identity().as_str())
                                                .copied()
                                                .unwrap_or(false)
                                        {
                                            track.disable();
                                        }
                                        false
                                    }
                                    RoomEvent::TrackSubscribed {
                                        track: RemoteTrack::Video(track),
                                        publication,
                                        participant,
                                    } => {
                                        let key = publication.sid().to_string();
                                        let _ = task_events.send(UiEvent::Media(Event::Video {
                                            key: key.clone(),
                                            identity: participant.identity().to_string(),
                                            label: participant.name(),
                                        }));
                                        let frame_sink = frame_sink.clone();
                                        videos.spawn(async move {
                                            let mut stream =
                                                NativeVideoStream::new(track.rtc_track());
                                            while let Some(frame) = stream.next().await {
                                                let w = frame.buffer.width();
                                                let h = frame.buffer.height();
                                                if w == 0 || h == 0 || w > 8192 || h > 8192 {
                                                    continue;
                                                }
                                                let mut rgba = vec![0; w as usize * h as usize * 4];
                                                frame.buffer.to_argb(
                                                    VideoFormatType::ABGR,
                                                    &mut rgba,
                                                    w * 4,
                                                    w as i32,
                                                    h as i32,
                                                );
                                                frame_sink.lock().unwrap().insert(
                                                    key.clone(),
                                                    Frame {
                                                        width: w,
                                                        height: h,
                                                        rgba,
                                                    },
                                                );
                                            }
                                            frame_sink.lock().unwrap().remove(&key);
                                        });
                                        false
                                    }
                                    RoomEvent::TrackUnsubscribed { publication, .. }
                                    | RoomEvent::TrackUnpublished { publication, .. } => {
                                        let _ = task_events.send(UiEvent::Media(
                                            Event::VideoRemoved(publication.sid().to_string()),
                                        ));
                                        true
                                    }
                                    RoomEvent::DataReceived {
                                        payload,
                                        topic,
                                        participant,
                                        ..
                                    } => {
                                        if let Ok(data) = serde_json::from_slice(&payload) {
                                            let _ = task_events.send(UiEvent::Media(Event::Data {
                                                topic: topic.unwrap_or_default(),
                                                data,
                                                from: participant
                                                    .map(|p| p.identity().to_string())
                                                    .unwrap_or_default(),
                                            }));
                                        }
                                        false
                                    }
                                    RoomEvent::Reconnecting => {
                                        let _ = task_events.send(UiEvent::Media(Event::State(
                                            "Восстанавливаю связь…".into(),
                                        )));
                                        false
                                    }
                                    RoomEvent::Reconnected => {
                                        let _ = task_events
                                            .send(UiEvent::Media(Event::State("В звонке".into())));
                                        true
                                    }
                                    RoomEvent::Disconnected { .. } => {
                                        let _ = task_events.send(UiEvent::Media(Event::Left));
                                        break;
                                    }
                                    RoomEvent::ParticipantConnected(_)
                                    | RoomEvent::ParticipantDisconnected(_)
                                    | RoomEvent::TrackMuted { .. }
                                    | RoomEvent::TrackUnmuted { .. }
                                    | RoomEvent::ActiveSpeakersChanged { .. } => true,
                                    _ => false,
                                };
                                if update {
                                    send_participants(&room_clone, &task_events);
                                }
                                while videos.try_join_next().is_some() {}
                            }
                        });
                        send_participants(&room, &events);
                        active = Some(Active {
                            room,
                            _audio: audio,
                            mic,
                            events: task,
                            screen: None,
                        });
                        let _ = events.send(UiEvent::Media(Event::Joined { conv, accept }));
                    }
                    Command::Leave => {
                        muted_users.lock().unwrap().clear();
                        if let Some(mut current) = active.take() {
                            stop_screen(&mut current).await;
                            current.events.abort();
                            current.mic.mute();
                            let _ = current.room.close().await;
                        }
                        frames.lock().unwrap().clear();
                        let _ = events.send(UiEvent::Media(Event::Left));
                    }
                    Command::Mute(value) => {
                        muted = value;
                        if let Some(a) = &active {
                            if muted || deaf {
                                a.mic.mute();
                            } else {
                                a.mic.unmute();
                            }
                        }
                    }
                    Command::Deaf(value) => {
                        deaf = value;
                        deaf_flag.store(value, Ordering::Relaxed);
                        if let Some(a) = &active {
                            if muted || deaf {
                                a.mic.mute();
                            } else {
                                a.mic.unmute();
                            }
                            for p in a.room.remote_participants().values() {
                                for t in p.track_publications().values() {
                                    if let Some(RemoteTrack::Audio(t)) = t.track() {
                                        if deaf
                                            || muted_users
                                                .lock()
                                                .unwrap()
                                                .get(p.identity().as_str())
                                                .copied()
                                                .unwrap_or(false)
                                        {
                                            t.disable();
                                        } else {
                                            t.enable();
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Command::Volumes(value) => {
                        *playback.lock().unwrap() = value.clone();
                        if let Some(a) = &active {
                            for p in a.room.remote_participants().values() {
                                for publication in p.track_publications().values() {
                                    if let Some(RemoteTrack::Audio(track)) = publication.track() {
                                        track.rtc_track().set_volume(value.gain(
                                            p.identity().as_str(), publication.source() == TrackSource::ScreenshareAudio));
                                    }
                                }
                            }
                        }
                    }
                    Command::MuteUser { identity, muted } => {
                        muted_users.lock().unwrap().insert(identity.clone(), muted);
                        if let Some(a) = &active {
                            for p in a
                                .room
                                .remote_participants()
                                .values()
                                .filter(|p| p.identity().as_str() == identity)
                            {
                                for t in p.track_publications().values() {
                                    if let Some(RemoteTrack::Audio(t)) = t.track() {
                                        if muted {
                                            t.disable();
                                        } else if !deaf {
                                            t.enable();
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Command::Screen {
                        window,
                        id,
                        height,
                        fps,
                        audio,
                    } => {
                        let Some(a) = active.as_mut() else {
                            bail!("Сначала подключитесь к звонку");
                        };
                        stop_screen(a).await;
                        let source = NativeVideoSource::new(
                            VideoResolution {
                                width: height * 16 / 9,
                                height,
                            },
                            true,
                        );
                        let track = LocalVideoTrack::create_video_track(
                            "screen",
                            RtcVideoSource::Native(source.clone()),
                        );
                        let publication = a
                            .room
                            .local_participant()
                            .publish_track(
                                LocalTrack::Video(track),
                                TrackPublishOptions {
                                    source: TrackSource::Screenshare,
                                    simulcast: false,
                                    video_codec: livekit::options::VideoCodec::VP9,
                                    video_encoding: Some(livekit::options::VideoEncoding {
                                        max_bitrate: 8_000_000,
                                        max_framerate: fps as f64,
                                    }),
                                    ..Default::default()
                                },
                            )
                            .await?;
                        let stop = Arc::new(AtomicBool::new(false));
                        let stop_capture = stop.clone();
                        let out = events.clone();
                        let ended = internal.clone();
                        let sid = publication.sid();
                        std::thread::spawn(move || {
                            let result = capture(source, stop_capture, window, id, height, fps);
                            if let Err(e) = result {
                                let _ = out.send(UiEvent::Error {
                                    tag: "screen".into(),
                                    message: format!("{e:#}"),
                                });
                            }
                            let _ = ended.send(Command::CaptureEnded(sid));
                        });
                        a.screen = Some(Screen { sid: publication.sid(), stop: stop.clone(), audio: None, forward: None });
                        if audio {
                            let input = tokio::task::spawn_blocking(move || crate::loopback::start(stop)).await?;
                            match input {
                                Ok(mut input) => {
                                    let source = NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, 48000, 2, 100);
                                    let track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(source.clone()));
                                    match a.room.local_participant().publish_track(LocalTrack::Audio(track), TrackPublishOptions { source: TrackSource::ScreenshareAudio, ..Default::default() }).await {
                                        Ok(publication) => {
                                            let screen = a.screen.as_mut().unwrap();
                                            screen.audio = Some(publication.sid());
                                            let out = events.clone();
                                            let flag = screen.stop.clone();
                                            screen.forward = Some(tokio::spawn(async move {
                                                while let Some(data) = input.recv().await {
                                                    if flag.load(Ordering::Relaxed) { return; }
                                                    if source.capture_frame(&AudioFrame { samples_per_channel: data.len() as u32 / 2, data: std::borrow::Cow::Owned(data), sample_rate: 48000, num_channels: 2 }).await.is_err() { break; }
                                                }
                                                if !flag.load(Ordering::Relaxed) {
                                                    let _ = out.send(UiEvent::Error { tag: "screen-audio".into(), message: "Захват системного звука прервался. Перезапустите демонстрацию.".into() });
                                                }
                                            }));
                                        }
                                        Err(e) => { let _ = events.send(UiEvent::Error { tag: "screen-audio".into(), message: e.to_string() }); }
                                    }
                                }
                                Err(e) => { let _ = events.send(UiEvent::Error { tag: "screen-audio".into(), message: format!("Экран показывается без системного звука: {e}") }); }
                            }
                        }
                        let _ = events.send(UiEvent::Media(Event::Screen(true)));
                    }
                    Command::CaptureEnded(sid) => {
                        if let Some(a) = active.as_mut() {
                            if a.screen.as_ref().is_some_and(|s| s.sid == sid) {
                                stop_screen(a).await;
                                let _ = events.send(UiEvent::Media(Event::Screen(false)));
                            }
                        }
                    }
                    Command::StopScreen => {
                        if let Some(a) = active.as_mut() {
                            stop_screen(a).await;
                        }
                        let _ = events.send(UiEvent::Media(Event::Screen(false)));
                    }
                    Command::Subscribe { sid, enabled } => {
                        if let Some(a) = &active {
                            for p in a.room.remote_participants().values() {
                                for t in p.track_publications().values() {
                                    if t.sid().as_str() == sid
                                        || sid == format!("user:{}", p.identity())
                                    {
                                        t.set_subscribed(enabled);
                                    }
                                }
                            }
                        }
                    }
                    Command::Data { topic, data } => {
                        if let Some(a) = &active {
                            a.room
                                .local_participant()
                                .publish_data(livekit::DataPacket {
                                    payload: serde_json::to_vec(&data)?,
                                    topic: Some(topic),
                                    reliable: true,
                                    ..Default::default()
                                })
                                .await?;
                        }
                    }
                    Command::Devices => {
                        let audio = PlatformAudio::new()?;
                        let microphones = audio
                            .recording_devices()
                            .map(|d| (d.id.as_str().to_string(), d.name))
                            .collect();
                        let outputs = audio
                            .playout_devices()
                            .map(|d| (d.id.as_str().to_string(), d.name))
                            .collect();
                        let _ = events.send(UiEvent::Media(Event::Devices {
                            microphones,
                            outputs,
                        }));
                    }
                }
                Ok(())
            }
            .await;
            if let Err(e) = result {
                let _ = events.send(UiEvent::Error {
                    tag: "media".into(),
                    message: format!("{e:#}"),
                });
            }
        }
        if let Some(mut a) = active {
            stop_screen(&mut a).await;
            a.events.abort();
            let _ = a.room.close().await;
        }
    });
    tx
}

fn send_participants(room: &Room, events: &Sender<UiEvent>) {
    let people = std::iter::once((
        room.local_participant().identity().to_string(),
        room.local_participant().name(),
        false,
    ))
    .chain(
        room.remote_participants()
            .values()
            .map(|p| (p.identity().to_string(), p.name(), p.is_speaking())),
    )
    .collect();
    let _ = events.send(UiEvent::Media(Event::Participants(people)));
}
async fn stop_screen(a: &mut Active) {
    if let Some(screen) = a.screen.take() {
        screen.stop.store(true, Ordering::Relaxed);
        if let Some(task) = screen.forward {
            task.abort();
        }
        if let Some(sid) = screen.audio {
            let _ = a.room.local_participant().unpublish_track(&sid).await;
        }
        let _ = a
            .room
            .local_participant()
            .unpublish_track(&screen.sid)
            .await;
    }
}

fn capture(
    source: NativeVideoSource,
    stop: Arc<AtomicBool>,
    window: bool,
    id: u32,
    height: u32,
    fps: u32,
) -> Result<()> {
    enum Target {
        Monitor(xcap::Monitor),
        Window(xcap::Window),
    }
    let target = if window {
        Target::Window(
            xcap::Window::all()?
                .into_iter()
                .find(|w| w.id().ok() == Some(id))
                .ok_or_else(|| anyhow::anyhow!("Окно закрыто"))?,
        )
    } else {
        Target::Monitor(
            xcap::Monitor::all()?
                .into_iter()
                .find(|m| m.id().ok() == Some(id))
                .ok_or_else(|| anyhow::anyhow!("Монитор не найден"))?,
        )
    };
    let start = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let at = Instant::now();
        let image = match &target {
            Target::Monitor(m) => m.capture_image()?,
            Target::Window(w) => w.capture_image()?,
        };
        let image = if image.height() > height {
            image::imageops::resize(
                &image,
                ((image.width() as u64 * height as u64 / image.height() as u64) as u32).max(2),
                height,
                image::imageops::FilterType::Triangle,
            )
        } else {
            image
        };
        let (w, h) = image.dimensions();
        let mut buffer = I420Buffer::new(w, h);
        let (sy, su, sv) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        livekit::webrtc::native::yuv_helper::abgr_to_i420(
            image.as_raw(),
            w * 4,
            y,
            sy,
            u,
            su,
            v,
            sv,
            w as i32,
            h as i32,
        );
        source.capture_frame(&VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: start.elapsed().as_micros() as i64,
            frame_metadata: None,
            buffer,
        });
        std::thread::sleep(
            Duration::from_secs_f64(1. / fps.clamp(1, 60) as f64).saturating_sub(at.elapsed()),
        );
    }
    Ok(())
}
