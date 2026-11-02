//! Shared gain policy for existing tracks and tracks arriving after a reconnect.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Playback {
    pub master: f32,
    pub users: BTreeMap<String, f32>,
}

pub fn level(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0., 2.)
    } else {
        1.
    }
}

pub fn key(identity: &str, screen: bool) -> String {
    format!("{}:{identity}", if screen { "screen" } else { "voice" })
}

impl Playback {
    pub fn from_config(config: &Config) -> Self {
        Self {
            master: level(config.volume),
            users: config.user_volumes.clone(),
        }
    }

    pub fn gain(&self, identity: &str, screen: bool) -> f64 {
        f64::from(
            level(self.master)
                * level(
                    self.users
                        .get(&key(identity, screen))
                        .copied()
                        .unwrap_or(1.),
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_screen_and_master_are_independent_and_bounded() {
        let mut config = Config {
            volume: 0.5,
            ..Default::default()
        };
        config.user_volumes.insert(key("42", false), 0.4);
        config.user_volumes.insert(key("42", true), 1.8);
        let playback = Playback::from_config(&config);
        assert!((playback.gain("42", false) - 0.2).abs() < 1e-6);
        assert!((playback.gain("42", true) - 0.9).abs() < 1e-6);
        assert_eq!(playback.gain("24", false), 0.5);
        config.volume = 0.;
        assert_eq!(Playback::from_config(&config).gain("42", true), 0.);
        assert_eq!(level(f32::NAN), 1.);
        assert_eq!(level(f32::INFINITY), 1.);
        assert_eq!(level(-1.), 0.);
        assert_eq!(level(20.), 2.);
        let decoded: Config =
            serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(decoded.user_volumes, config.user_volumes);
    }
}
