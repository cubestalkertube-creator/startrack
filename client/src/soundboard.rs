//! Legacy-compatible `sb` data packets. Payloads never select an arbitrary URL.
use crate::audio::{self, Clip};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Sound {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub emoji: String,
    #[serde(default = "one")]
    pub vol: f32,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub uid: Option<i64>,
}
fn one() -> f32 {
    1.
}
pub fn builtins() -> Vec<Sound> {
    [
        ("airhorn", "Гудок", "📢", 0.8),
        ("sad", "Грустный тромбон", "🎺", 1.),
        ("badum", "Ба-дум-тсс", "🥁", 1.),
        ("cricket", "Сверчки", "🦗", 1.),
        ("clap", "Аплодисменты", "👏", 1.),
        ("quack", "Кря", "🦆", 1.),
        ("tada", "Тадам", "🎉", 0.9),
    ]
    .into_iter()
    .map(|(id, name, emoji, vol)| Sound {
        id: format!("b:{id}"),
        name: name.into(),
        emoji: emoji.into(),
        vol,
        file: None,
        uid: None,
    })
    .collect()
}
pub fn from_server(value: serde_json::Value) -> Vec<Sound> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(Sound {
                id: format!("f:{}", v["id"].as_i64()?),
                uid: v["uid"].as_i64(),
                name: v["name"].as_str()?.into(),
                emoji: v["emoji"].as_str().unwrap_or("🔊").into(),
                file: Some(v["file"].as_str()?.into()),
                vol: v["vol"].as_f64().unwrap_or(1.) as f32,
            })
        })
        .filter(Sound::valid)
        .collect()
}
impl Sound {
    pub fn valid(&self) -> bool {
        if !self.vol.is_finite() || !(0. ..=1.).contains(&self.vol) {
            return false;
        }
        if self.id.starts_with("b:") {
            return builtins().iter().any(|s| s.id == self.id);
        }
        if !self
            .id
            .strip_prefix("f:")
            .and_then(|s| s.parse::<i64>().ok())
            .is_some_and(|id| id > 0)
        {
            return false;
        }
        self.file.as_deref().is_some_and(valid_file)
    }
}
pub fn valid_file(file: &str) -> bool {
    let Some((hash, ext)) = file.split_once('.') else {
        return false;
    };
    hash.len() == 32
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(ext, "wav" | "mp3" | "ogg")
}

#[derive(Default)]
pub struct RateLimit {
    recent: BTreeMap<String, VecDeque<Instant>>,
}
impl RateLimit {
    pub fn accept(&mut self, identity: &str, now: Instant) -> bool {
        self.recent.retain(|_, list| {
            list.back()
                .is_some_and(|t| now.duration_since(*t) < Duration::from_secs(3))
        });
        if self.recent.len() >= 64 && !self.recent.contains_key(identity) {
            return false;
        }
        let recent = self.recent.entry(identity.into()).or_default();
        while recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(3))
        {
            recent.pop_front();
        }
        if recent.len() >= 4 {
            return false;
        }
        recent.push_back(now);
        true
    }
}

/// Deterministic native versions of the seven Web Audio presets.
pub fn synth(id: &str) -> Option<Clip> {
    let mut c = audio::silence(match id {
        "b:airhorn" => 1.2,
        "b:sad" => 2.8,
        "b:badum" => 1.9,
        "b:cricket" => 2.3,
        "b:clap" => 2.7,
        "b:quack" => 0.6,
        "b:tada" => 1.4,
        _ => return None,
    });
    match id {
        "b:airhorn" => {
            for t in [0., 0.22, 0.44] {
                for f in [220., 277., 329.] {
                    audio::tone(&mut c, t, 0.65, f, f, 0.1, true);
                }
            }
        }
        "b:sad" => {
            for (f, t, d) in [
                (293.66, 0., 0.35),
                (277.18, 0.4, 0.35),
                (261.63, 0.8, 0.35),
                (246.94, 1.2, 1.5),
            ] {
                audio::tone(&mut c, t, d, f, f * 0.96, 0.4, true);
            }
        }
        "b:badum" => {
            audio::noise(&mut c, 0., 0.14, 0.4);
            audio::tone(&mut c, 0., 0.1, 200., 150., 0.5, false);
            audio::tone(&mut c, 0.2, 0.3, 150., 85., 0.7, false);
            audio::noise(&mut c, 0.45, 1.3, 0.3);
        }
        "b:cricket" => {
            for (f, off) in [(4600., 0.), (4250., 0.23)] {
                for g in 0..4 {
                    for p in 0..3 {
                        audio::tone(
                            &mut c,
                            off + g as f32 * 0.5 + p as f32 * 0.042,
                            0.026,
                            f,
                            f,
                            0.2,
                            false,
                        );
                    }
                }
            }
        }
        "b:clap" => {
            for t in [0., 0.48, 1.02, 1.47, 1.98, 2.45] {
                for k in [0., 0.009, 0.018] {
                    audio::noise(&mut c, t + k, 0.12, 0.4);
                }
            }
        }
        "b:quack" => {
            for t in [0., 0.3] {
                audio::tone(&mut c, t, 0.19, 420., 310., 0.55, true);
            }
        }
        "b:tada" => {
            for f in [523.25, 659.25, 783.99] {
                audio::tone(&mut c, 0., 0.13, f, f, 0.13, true);
            }
            for f in [523.25, 659.25, 783.99, 1046.5] {
                audio::tone(&mut c, 0.17, 1.1, f, f, 0.13, true);
            }
        }
        _ => {}
    }
    for s in &mut c.samples {
        *s = s.clamp(-1., 1.);
    }
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_packets_and_rate_limit() {
        let packet = serde_json::json!({"id":"f:7","file":"0123456789abcdef0123456789abcdef.mp3","vol":0.8,"emoji":"👏"});
        let mut sound: Sound = serde_json::from_value(packet).unwrap();
        assert!(sound.valid());
        sound.file = Some("../../secret.wav".into());
        assert!(!sound.valid());
        sound.id = "b:quack".into();
        sound.vol = f32::NAN;
        assert!(!sound.valid());
        let mut rate = RateLimit::default();
        let now = Instant::now();
        for _ in 0..4 {
            assert!(rate.accept("2", now));
        }
        assert!(!rate.accept("2", now));
        assert!(rate.accept("3", now));
        assert!(rate.accept("2", now + Duration::from_secs(3)));
        for sound in builtins() {
            let c = synth(&sound.id).unwrap();
            assert!(c.duration() <= audio::MAX_SECONDS);
            assert!(c.samples.iter().all(|s| s.is_finite() && s.abs() <= 1.));
            assert!(c.samples.iter().any(|s| s.abs() > 0.01));
        }
    }
}
