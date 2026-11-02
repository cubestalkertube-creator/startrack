use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub server: String,
    pub username: String,
    pub theme: String,
    pub volume: f32,
    pub microphone: String,
    pub output: String,
    pub noise_suppression: bool,
    pub relay: bool,
    pub screen_height: u32,
    pub screen_fps: u32,
    pub notifications: bool,
    pub sfx_volume: f32,
    pub sfx_off: std::collections::BTreeSet<String>,
    pub soundboard_volume: f32,
    pub sound_favorites: std::collections::BTreeSet<String>,
    pub sound_output: String,
    pub animate_gifs: bool,
    pub close_to_tray: bool,
    pub autostart: bool,
    pub verity_pc: String,
    pub check_updates: bool,
    pub show_games: bool,
    pub user_volumes: std::collections::BTreeMap<String, f32>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            server: "https://185-218-0-111.sslip.io".into(),
            username: String::new(),
            theme: "dark".into(),
            volume: 1.,
            microphone: String::new(),
            output: String::new(),
            noise_suppression: true,
            relay: false,
            screen_height: 1080,
            screen_fps: 30,
            notifications: true,
            sfx_volume: 0.6,
            sfx_off: Default::default(),
            soundboard_volume: 0.8,
            sound_favorites: Default::default(),
            sound_output: String::new(),
            animate_gifs: true,
            close_to_tray: true,
            autostart: false,
            verity_pc: "ask".into(),
            check_updates: true,
            show_games: true,
            user_volumes: Default::default(),
        }
    }
}
pub fn directory() -> PathBuf {
    if let Some(path) = std::env::var_os("STARTRACK_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    directories::ProjectDirs::from("app", "startrack", "Startrack")
        .map(|p| p.config_dir().to_owned())
        .unwrap_or_else(|| PathBuf::from(".startrack"))
}
impl Config {
    pub fn load() -> Self {
        std::fs::read(directory().join("native.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
    pub fn save(&self) -> Result<()> {
        let dir = directory();
        std::fs::create_dir_all(&dir)?;
        let dest = dir.join("native.json");
        let temp = dir.join("native.json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(self)?)
            .context("Не удалось сохранить настройки")?;
        std::fs::rename(temp, dest).context("Не удалось заменить настройки")?;
        Ok(())
    }
}
