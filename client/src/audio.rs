//! Native output for interface sounds and the soundboard. Never opens a microphone.
use anyhow::{bail, Context, Result};
use rodio::{
    cpal::traits::{DeviceTrait, HostTrait},
    Source,
};
use std::{io::Cursor, sync::mpsc, time::Duration};

pub const RATE: u32 = 44_100;
pub const MAX_SECONDS: f32 = 5.2;

#[derive(Clone, Debug)]
pub struct Clip {
    pub samples: Vec<f32>,
}
impl Clip {
    pub fn duration(&self) -> f32 {
        self.samples.len() as f32 / RATE as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Cue,
    Board,
    Preview,
    Ring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    Message,
    Connect,
    Disconnect,
    Join,
    Leave,
    Mute,
    Unmute,
    Deafen,
    Undeafen,
    StreamStart,
    StreamEnd,
    Calling,
    Ring,
}
pub const GROUPS: &[(&str, &str, Cue)] = &[
    ("message", "Новое сообщение", Cue::Message),
    ("call", "Вход и выход из звонка", Cue::Connect),
    ("mute", "Микрофон", Cue::Mute),
    ("deafen", "Отключение звука", Cue::Deafen),
    ("stream", "Демонстрация экрана", Cue::StreamStart),
    ("calling", "Исходящий вызов", Cue::Calling),
    ("ring", "Входящий звонок", Cue::Ring),
];
impl Cue {
    pub fn group(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Connect | Self::Disconnect | Self::Join | Self::Leave => "call",
            Self::Mute | Self::Unmute => "mute",
            Self::Deafen | Self::Undeafen => "deafen",
            Self::StreamStart | Self::StreamEnd => "stream",
            Self::Calling => "calling",
            Self::Ring => "ring",
        }
    }
    pub fn clip(self) -> Clip {
        let notes: &[(f32, f32, f32)] = match self {
            Self::Message => &[(987.77, 0., 0.16), (1318.51, 0.07, 0.4)],
            Self::Connect => &[(523.25, 0., 0.3), (659.25, 0.09, 0.3), (783.99, 0.18, 0.5)],
            Self::Disconnect => &[(783.99, 0., 0.3), (659.25, 0.09, 0.3), (523.25, 0.18, 0.5)],
            Self::Join => &[(783.99, 0., 0.25), (1046.5, 0.1, 0.45)],
            Self::Leave => &[(1046.5, 0., 0.25), (783.99, 0.1, 0.45)],
            Self::Mute => &[(659.25, 0., 0.12), (440., 0.07, 0.2)],
            Self::Unmute => &[(440., 0., 0.12), (659.25, 0.07, 0.2)],
            Self::Deafen => &[(783.99, 0., 0.12), (587.33, 0.07, 0.12), (392., 0.14, 0.25)],
            Self::Undeafen => &[(392., 0., 0.12), (587.33, 0.07, 0.12), (783.99, 0.14, 0.25)],
            Self::StreamStart => &[(420., 0., 0.22), (880., 0.16, 0.2), (1318.51, 0.24, 0.45)],
            Self::StreamEnd => &[(1318.51, 0., 0.15), (880., 0.08, 0.2), (420., 0.16, 0.3)],
            Self::Calling => &[(587.33, 0., 0.7), (880., 0.22, 0.9)],
            Self::Ring => &[
                (659.25, 0., 0.3),
                (880., 0.12, 0.3),
                (659.25, 0.24, 0.3),
                (880., 0.36, 0.3),
                (1046.5, 0.48, 0.8),
            ],
        };
        let duration = match self {
            Self::Calling => 2.6,
            Self::Ring => 2.,
            _ => notes.iter().map(|(_, t, d)| t + d).fold(0., f32::max) + 0.05,
        };
        let mut clip = silence(duration);
        for &(f, t, d) in notes {
            for (mul, gain, decay) in [(1., 0.15, 1.), (2., 0.033, 0.5), (3., 0.009, 0.3)] {
                tone(&mut clip, t, d * decay, f * mul, f * mul, gain, false);
            }
        }
        clip
    }
}

pub fn silence(seconds: f32) -> Clip {
    Clip {
        samples: vec![0.; (seconds * RATE as f32).ceil() as usize],
    }
}
pub fn tone(
    clip: &mut Clip,
    start: f32,
    duration: f32,
    frequency: f32,
    end: f32,
    gain: f32,
    brass: bool,
) {
    let offset = (start * RATE as f32) as usize;
    let mut phase = 0.;
    for (i, sample) in clip
        .samples
        .iter_mut()
        .skip(offset)
        .take((duration * RATE as f32) as usize)
        .enumerate()
    {
        let t = i as f32 / RATE as f32;
        phase +=
            std::f32::consts::TAU * (frequency + (end - frequency) * t / duration) / RATE as f32;
        let envelope =
            (t / 0.008).min(1.) * (-6. * t / duration).exp() * ((duration - t) / 0.025).min(1.);
        let wave = phase.sin()
            + if brass {
                0.3 * (phase * 2.).sin() + 0.15 * (phase * 3.).sin()
            } else {
                0.
            };
        *sample += wave * envelope * gain;
    }
}
pub fn noise(clip: &mut Clip, start: f32, duration: f32, gain: f32) {
    let mut seed = 0x1234_5678u32;
    for (i, s) in clip
        .samples
        .iter_mut()
        .skip((start * RATE as f32) as usize)
        .take((duration * RATE as f32) as usize)
        .enumerate()
    {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let t = i as f32 / RATE as f32;
        *s += (seed as f32 / u32::MAX as f32 * 2. - 1.)
            * gain
            * (t / 0.003).min(1.)
            * (-5. * t / duration).exp();
    }
}

/// Decode only the requested segment. The resampler bounds output to 5.2 seconds.
pub fn decode(bytes: Vec<u8>, start: f32, seconds: f32) -> Result<Clip> {
    if !start.is_finite()
        || !(0. ..=600.).contains(&start)
        || !seconds.is_finite()
        || !(0.05..=MAX_SECONDS).contains(&seconds)
    {
        bail!("Выберите фрагмент от 0,05 до 5,2 секунды (начало — до 10 минут)");
    }
    decode_segment(bytes, start, seconds)
}
pub fn decode_ringtone(bytes: Vec<u8>) -> Result<Clip> {
    decode_segment(bytes, 0., 30.)
}
fn decode_segment(bytes: Vec<u8>, start: f32, seconds: f32) -> Result<Clip> {
    let decoder = rodio::Decoder::try_from(Cursor::new(bytes))
        .context("Не удалось прочитать звук WAV, MP3 или OGG")?;
    let source = rodio::source::UniformSourceIterator::new(decoder, 1, RATE);
    let samples: Vec<_> = source
        .skip_duration(Duration::from_secs_f32(start))
        .take((seconds * RATE as f32) as usize)
        .map(|s| if s.is_finite() { s.clamp(-1., 1.) } else { 0. })
        .collect();
    if samples.is_empty() {
        bail!("За началом фрагмента нет звука");
    }
    Ok(Clip { samples })
}
pub fn wav(clip: &Clip) -> Vec<u8> {
    let n = clip.samples.len() * 2;
    let mut out = Vec::with_capacity(44 + n);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + n as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(n as u32).to_le_bytes());
    let len = clip.samples.len();
    for (i, &sample) in clip.samples.iter().enumerate() {
        let envelope = (i as f32 / (RATE as f32 * 0.005)).min(1.)
            * ((len - 1 - i) as f32 / (RATE as f32 * 0.03)).min(1.);
        out.extend_from_slice(
            &(((sample * envelope).clamp(-1., 1.) * i16::MAX as f32) as i16).to_le_bytes(),
        );
    }
    out
}

enum Command {
    Play {
        clip: Clip,
        gain: f32,
        lane: Lane,
        repeat: bool,
    },
    Stop(Lane),
    StopAll,
    Configure {
        output: String,
        sfx: f32,
        board: f32,
    },
}
pub struct Output {
    tx: mpsc::Sender<Command>,
}
impl Output {
    pub fn start(events: mpsc::Sender<crate::worker::Event>) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stream: Option<rodio::OutputStream> = None;
            let mut playing: Vec<(Lane, f32, rodio::Sink)> = vec![];
            let mut output = String::new();
            let (mut sfx, mut board) = (0.6, 0.8);
            while let Ok(command) = rx.recv() {
                playing.retain(|(_, _, sink)| !sink.empty());
                match command {
                    Command::Stop(lane) => playing.retain(|(l, _, _)| *l != lane),
                    Command::StopAll => {
                        playing.clear();
                        stream = None;
                    }
                    Command::Configure {
                        output: name,
                        sfx: s,
                        board: b,
                    } => {
                        sfx = volume(s);
                        board = volume(b);
                        if name != output {
                            playing.clear();
                            stream = None;
                            output = name;
                        }
                        for (lane, gain, sink) in &playing {
                            sink.set_volume(
                                *gain
                                    * if matches!(lane, Lane::Board | Lane::Preview) {
                                        board
                                    } else {
                                        sfx
                                    },
                            );
                        }
                    }
                    Command::Play {
                        clip,
                        gain,
                        lane,
                        repeat,
                    } => {
                        let gain = volume(gain);
                        let level = gain
                            * if matches!(lane, Lane::Board | Lane::Preview) {
                                board
                            } else {
                                sfx
                            };
                        if level <= 0. {
                            continue;
                        }
                        if matches!(lane, Lane::Ring | Lane::Preview) {
                            playing.retain(|(l, _, _)| *l != lane);
                        }
                        if playing.len() >= 16 {
                            playing.remove(0);
                        }
                        if stream.is_none() {
                            match open_output(&output) {
                                Ok(s) => stream = Some(s),
                                Err(e) => {
                                    let _ = events.send(crate::worker::Event::Error {
                                        tag: "audio".into(),
                                        message: format!("Не удалось включить звук: {e}"),
                                    });
                                    continue;
                                }
                            }
                        }
                        let sink = rodio::Sink::connect_new(stream.as_ref().unwrap().mixer());
                        sink.set_volume(level);
                        let source = rodio::buffer::SamplesBuffer::new(1, RATE, clip.samples);
                        if repeat {
                            sink.append(source.repeat_infinite());
                        } else {
                            sink.append(source);
                        }
                        playing.push((lane, gain, sink));
                    }
                }
            }
        });
        Self { tx }
    }
    pub fn play(&self, clip: Clip, gain: f32, lane: Lane, repeat: bool) {
        let _ = self.tx.send(Command::Play {
            clip,
            gain,
            lane,
            repeat,
        });
    }
    pub fn stop(&self, lane: Lane) {
        let _ = self.tx.send(Command::Stop(lane));
    }
    pub fn stop_all(&self) {
        let _ = self.tx.send(Command::StopAll);
    }
    pub fn configure(&self, config: &crate::config::Config) {
        let _ = self.tx.send(Command::Configure {
            output: config.sound_output.clone(),
            sfx: config.sfx_volume,
            board: config.soundboard_volume,
        });
    }
}
pub fn volume(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0., 1.)
    } else {
        0.
    }
}
pub fn outputs() -> Vec<String> {
    rodio::cpal::default_host()
        .output_devices()
        .map(|ds| ds.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}
fn open_output(name: &str) -> Result<rodio::OutputStream> {
    let mut stream = if name.is_empty() {
        rodio::OutputStreamBuilder::open_default_stream()?
    } else {
        let device = rodio::cpal::default_host()
            .output_devices()?
            .find(|d| d.name().is_ok_and(|n| n == name))
            .context(
                "Выбранные динамики недоступны; выберите другое устройство в настройках звука",
            )?;
        rodio::OutputStreamBuilder::from_device(device)?.open_stream_or_fallback()?
    };
    stream.log_on_drop(false);
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wav_trim_round_trip_and_invalid_segments() {
        let original = Cue::Ring.clip();
        let bytes = wav(&original);
        let trimmed = decode(bytes.clone(), 0.1, 0.2).unwrap();
        assert!((trimmed.duration() - 0.2).abs() < 0.001);
        assert!(trimmed.samples.iter().any(|s| s.abs() > 0.01));
        assert!(decode(bytes.clone(), f32::NAN, 1.).is_err());
        assert!(decode(bytes.clone(), 0., 500.).is_err());
        assert!(decode(bytes, 600., 1.).is_err());
        assert!(decode(vec![0; 100], 0., 1.).is_err());
        let ringtone = decode_ringtone(include_bytes!("assets/ringtone.mp3").to_vec()).unwrap();
        assert!(ringtone.duration() > 0. && ringtone.duration() <= 30.);
        assert!(ringtone.samples.iter().any(|s| s.abs() > 0.01));
    }
}
