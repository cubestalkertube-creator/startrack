use super::*;
use crate::{
    audio::{self, Cue, Lane},
    soundboard::{self, Sound},
};

#[derive(Default)]
pub(super) struct Sounds {
    looping: Option<Cue>,
    ring_epoch: u64,
    ringtone: Option<audio::Clip>,
    epoch: u64,
    preview_epoch: u64,
    last_sent: Option<Instant>,
    rate: soundboard::RateLimit,
    list: Vec<Sound>,
    window: glib::WeakRef<gtk::Window>,
    rows: glib::WeakRef<gtk::Box>,
    search: glib::WeakRef<gtk::SearchEntry>,
    favorites_only: bool,
    editor: glib::WeakRef<gtk::Window>,
    save: glib::WeakRef<gtk::Button>,
}

impl Client {
    pub(super) fn cue(&self, cue: Cue) {
        let config = self.config.borrow();
        if config.sfx_off.contains(cue.group()) || config.sfx_volume <= 0. {
            return;
        }
        self.audio.play(cue.clip(), 1., Lane::Cue, false);
    }
    pub(super) fn sync_ringing(&self) {
        let wanted = {
            let state = self.state.borrow();
            let silent = state.deaf || state.session.as_ref().is_none_or(|s| s.me.status == "dnd");
            if silent {
                None
            } else if state.incoming.is_some() {
                Some(Cue::Ring)
            } else if state.ringing && state.call.is_some() {
                Some(Cue::Calling)
            } else {
                None
            }
        }
        .filter(|cue| {
            let c = self.config.borrow();
            c.sfx_volume > 0. && !c.sfx_off.contains(cue.group())
        });
        if self.sounds.borrow().looping == wanted {
            return;
        }
        self.sounds.borrow_mut().looping = wanted;
        self.audio.stop(Lane::Ring);
        if let Some(cue) = wanted {
            let clip = if cue == Cue::Ring {
                self.sounds
                    .borrow()
                    .ringtone
                    .clone()
                    .unwrap_or_else(|| cue.clip())
            } else {
                cue.clip()
            };
            self.audio.play(clip, 1., Lane::Ring, true);
        }
    }
    pub(super) fn configure_sounds(&self) {
        self.audio.configure(&self.config.borrow());
        self.sounds.borrow_mut().looping = None;
        self.audio.stop(Lane::Ring);
        self.sync_ringing();
    }
    pub(super) fn stop_board(&self) {
        let mut sounds = self.sounds.borrow_mut();
        sounds.epoch = sounds.epoch.wrapping_add(1);
        sounds.preview_epoch = sounds.preview_epoch.wrapping_add(1);
        self.audio.stop(Lane::Board);
        self.audio.stop(Lane::Preview);
    }
    pub(super) fn close_soundboard(&self) {
        let (window, editor) = {
            let sounds = self.sounds.borrow();
            (sounds.window.upgrade(), sounds.editor.upgrade())
        };
        if let Some(editor) = editor {
            editor.close();
        }
        if let Some(window) = window {
            window.close();
        }
        let mut sounds = self.sounds.borrow_mut();
        sounds.rate = Default::default();
        sounds.last_sent = None;
    }
    pub(super) fn reset_sounds(&self) {
        self.stop_board();
        self.audio.stop_all();
        let mut sounds = self.sounds.borrow_mut();
        sounds.list.clear();
        sounds.rate = Default::default();
        sounds.last_sent = None;
        sounds.looping = None;
        sounds.ring_epoch = sounds.ring_epoch.wrapping_add(1);
        sounds.ringtone = None;
    }
    pub(super) fn load_ringtone(&self) {
        let mut sounds = self.sounds.borrow_mut();
        sounds.ring_epoch = sounds.ring_epoch.wrapping_add(1);
        sounds.ringtone = None;
        self.send(Command::Ringtone {
            epoch: sounds.ring_epoch,
        });
    }
    pub(super) fn received_ringtone(&self, epoch: u64, clip: audio::Clip) {
        if self.sounds.borrow().ring_epoch != epoch || self.state.borrow().incoming.is_none() {
            return;
        }
        self.sounds.borrow_mut().ringtone = Some(clip);
        self.sounds.borrow_mut().looping = None;
        self.sync_ringing();
    }
    fn stop_preview(&self) {
        let mut sounds = self.sounds.borrow_mut();
        sounds.preview_epoch = sounds.preview_epoch.wrapping_add(1);
        self.audio.stop(Lane::Preview);
    }
    pub(super) fn received_sound(&self, epoch: u64, preview: bool, clip: audio::Clip, gain: f32) {
        let state = self.state.borrow();
        let sounds = self.sounds.borrow();
        if state.session.is_none() || state.deaf {
            return;
        }
        if preview {
            if epoch != sounds.preview_epoch {
                return;
            }
        } else if epoch != sounds.epoch || state.call.is_none() {
            return;
        }
        self.audio.play(
            clip,
            gain,
            if preview { Lane::Preview } else { Lane::Board },
            false,
        );
    }
    pub(super) fn board_received(&self, from: &str, data: Value) {
        let allowed = {
            let s = self.state.borrow();
            s.call.is_some()
                && !s.deaf
                && !s.user_mutes.get(from).copied().unwrap_or(false)
                && s.participants.iter().any(|(id, _, _)| id == from)
        };
        if !allowed {
            return;
        }
        let Ok(sound) = serde_json::from_value::<Sound>(data) else {
            return;
        };
        if !sound.valid() || !self.sounds.borrow_mut().rate.accept(from, Instant::now()) {
            return;
        }
        self.load_sound(sound, false);
    }
    fn load_sound(&self, sound: Sound, preview: bool) {
        if self.state.borrow().deaf {
            self.toast("Включите звук, чтобы прослушать");
            return;
        }
        let epoch = if preview {
            self.stop_preview();
            self.sounds.borrow().preview_epoch
        } else {
            self.sounds.borrow().epoch
        };
        self.send(Command::Sound {
            sound,
            epoch,
            preview,
        });
    }
    fn play_board(&self, sound: Sound) {
        if self.state.borrow().call.is_none() {
            self.toast("Звуковая панель работает в звонке");
            return;
        }
        if self.state.borrow().deaf {
            self.toast("Включите звук, чтобы пользоваться панелью");
            return;
        }
        if self
            .sounds
            .borrow()
            .last_sent
            .is_some_and(|t| t.elapsed() < Duration::from_millis(600))
        {
            return;
        }
        self.sounds.borrow_mut().last_sent = Some(Instant::now());
        self.media(media::Command::Data {
            topic: "sb".into(),
            data: json!({"id":sound.id,"file":sound.file,"vol":sound.vol,"emoji":sound.emoji}),
        });
        self.load_sound(sound, false);
    }
    pub(super) fn soundboard(self: &App) {
        if let Some(window) = self.sounds.borrow().window.upgrade() {
            window.present();
            return;
        }
        if self.state.borrow().call.is_none() {
            self.toast("Звуковая панель работает в звонке");
            return;
        }
        let dialog = self.dialog("Звуковая панель", 650, 570);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&box_, 16);
        let search = gtk::SearchEntry::new();
        search.set_placeholder_text(Some("Найти звук"));
        box_.append(&search);
        let favorites = gtk::CheckButton::with_label("Только избранное");
        box_.append(&favorites);
        box_.append(&label("Громкость панели у вас", "muted"));
        let volume = gtk::Scale::with_range(gtk::Orientation::Horizontal, 0., 100., 1.);
        volume.set_value((audio::volume(self.config.borrow().soundboard_volume) * 100.) as f64);
        box_.append(&volume);
        let rows = gtk::Box::new(gtk::Orientation::Vertical, 5);
        let scroll = gtk::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .child(&rows)
            .build();
        box_.append(&scroll);
        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let add = button("Добавить звук…", "suggested-action");
        let stop = button("Остановить у себя", "");
        actions.append(&add);
        actions.append(&stop);
        box_.append(&actions);
        dialog.set_child(Some(&box_));
        {
            let mut s = self.sounds.borrow_mut();
            s.window = dialog.downgrade();
            s.rows = rows.downgrade();
            s.search = search.downgrade();
            s.favorites_only = false;
        }
        let weak = Rc::downgrade(self);
        search.connect_search_changed(move |_| {
            if let Some(a) = weak.upgrade() {
                a.draw_soundboard();
            }
        });
        let weak = Rc::downgrade(self);
        favorites.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.sounds.borrow_mut().favorites_only = b.is_active();
                a.draw_soundboard();
            }
        });
        let weak = Rc::downgrade(self);
        volume.connect_value_changed(move |v| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().soundboard_volume = v.value() as f32 / 100.;
                a.configure_sounds();
                let _ = a.config.borrow().save();
            }
        });
        let weak = Rc::downgrade(self);
        add.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.sound_editor(None);
            }
        });
        let weak = Rc::downgrade(self);
        stop.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.stop_board();
            }
        });
        let weak = Rc::downgrade(self);
        dialog.connect_close_request(move |_| {
            if let Some(a) = weak.upgrade() {
                a.stop_preview();
            }
            glib::Propagation::Proceed
        });
        self.draw_soundboard();
        self.load_sound_list();
        dialog.present();
    }
    fn load_sound_list(&self) {
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        let mut ids = vec![session.me.id.to_string()];
        ids.extend(
            state
                .participants
                .iter()
                .filter_map(|(id, _, _)| id.parse::<i64>().ok().map(|i| i.to_string())),
        );
        ids.sort();
        ids.dedup();
        self.request(
            "sound-list",
            format!("/api/sounds?users={}", ids.join(",")),
            None,
        );
    }
    fn draw_soundboard(self: &App) {
        let sounds = self.sounds.borrow();
        let Some(rows) = sounds.rows.upgrade() else {
            return;
        };
        let filter = sounds
            .search
            .upgrade()
            .map(|s| s.text().to_lowercase())
            .unwrap_or_default();
        let favorites_only = sounds.favorites_only;
        let mut list = soundboard::builtins();
        list.extend(sounds.list.clone());
        drop(sounds);
        clear(&rows);
        let me = self
            .state
            .borrow()
            .session
            .as_ref()
            .map(|s| s.me.id)
            .unwrap_or(0);
        for sound in list {
            let favorite = self.config.borrow().sound_favorites.contains(&sound.id);
            if (favorites_only && !favorite) || !sound.name.to_lowercase().contains(&filter) {
                continue;
            }
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 5);
            let play = button(&format!("{}  {}", sound.emoji, sound.name), "");
            play.set_hexpand(true);
            let preview = button("▶", "");
            preview.set_tooltip_text(Some("Прослушать только у себя"));
            let star = button(if favorite { "★" } else { "☆" }, "");
            star.set_tooltip_text(Some("Избранное"));
            row.append(&play);
            row.append(&preview);
            row.append(&star);
            let weak = Rc::downgrade(self);
            let s = sound.clone();
            play.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.play_board(s.clone());
                }
            });
            let weak = Rc::downgrade(self);
            let s = sound.clone();
            preview.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.load_sound(s.clone(), true);
                }
            });
            let weak = Rc::downgrade(self);
            let id = sound.id.clone();
            star.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    {
                        let mut c = a.config.borrow_mut();
                        if !c.sound_favorites.remove(&id) {
                            c.sound_favorites.insert(id.clone());
                        }
                        let _ = c.save();
                    }
                    a.draw_soundboard();
                }
            });
            if sound.uid == Some(me) {
                let edit = button("Изменить", "");
                row.append(&edit);
                let weak = Rc::downgrade(self);
                edit.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        a.sound_editor(Some(sound.clone()));
                    }
                });
            }
            rows.append(&row);
        }
        if rows.first_child().is_none() {
            rows.append(&label("Ничего не найдено", "muted"));
        }
    }
    fn sound_editor(self: &App, edit: Option<Sound>) {
        if let Some(window) = self.sounds.borrow().editor.upgrade() {
            window.present();
            return;
        }
        let dialog = self.dialog(
            if edit.is_some() {
                "Изменить звук"
            } else {
                "Добавить звук"
            },
            460,
            480,
        );
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&box_, 20);
        let name = settings::field(
            &box_,
            "Название",
            edit.as_ref().map(|s| s.name.as_str()).unwrap_or(""),
        );
        name.set_max_length(32);
        let emoji = settings::field(
            &box_,
            "Эмодзи",
            edit.as_ref().map(|s| s.emoji.as_str()).unwrap_or("🔊"),
        );
        emoji.set_max_length(16);
        let volume = gtk::Scale::with_range(gtk::Orientation::Horizontal, 0., 100., 1.);
        volume.set_value(edit.as_ref().map(|s| s.vol as f64 * 100.).unwrap_or(100.));
        box_.append(&label("Громкость звука", "muted"));
        box_.append(&volume);
        let file = Rc::new(RefCell::new(None::<std::path::PathBuf>));
        let start = gtk::SpinButton::with_range(0., 600., 0.1);
        start.set_digits(1);
        let seconds = gtk::SpinButton::with_range(0.1, audio::MAX_SECONDS as f64, 0.1);
        seconds.set_digits(1);
        seconds.set_value(5.);
        if edit.is_none() {
            let pick = button("Выбрать WAV, MP3 или OGG…", "");
            box_.append(&pick);
            box_.append(&label("Начало фрагмента, секунды", "muted"));
            box_.append(&start);
            box_.append(&label("Длительность, секунды (до 5,2)", "muted"));
            box_.append(&seconds);
            let parent = dialog.clone();
            let path = file.clone();
            pick.connect_clicked(move |b| {
                let picker = gtk::FileChooserNative::builder()
                    .title("Выберите звук")
                    .transient_for(&parent)
                    .action(gtk::FileChooserAction::Open)
                    .build();
                let filter = gtk::FileFilter::new();
                for pattern in ["*.wav", "*.mp3", "*.ogg", "*.WAV", "*.MP3", "*.OGG"] {
                    filter.add_pattern(pattern);
                }
                picker.add_filter(&filter);
                let path = path.clone();
                let b = b.downgrade();
                picker.connect_response(move |d, r| {
                    if r == gtk::ResponseType::Accept {
                        if let Some(p) = d.file().and_then(|f| f.path()) {
                            if let Some(b) = b.upgrade() {
                                b.set_label(&p.file_name().unwrap_or_default().to_string_lossy());
                            }
                            *path.borrow_mut() = Some(p);
                        }
                    }
                    d.destroy();
                });
                picker.show();
            });
        }
        let preview = button("Прослушать фрагмент", "");
        let save = button("Сохранить", "suggested-action");
        box_.append(&preview);
        box_.append(&save);
        self.sounds.borrow_mut().editor = dialog.downgrade();
        self.sounds.borrow_mut().save = save.downgrade();
        let weak = Rc::downgrade(self);
        let path = file.clone();
        let begin = start.clone();
        let length = seconds.clone();
        let vol = volume.clone();
        let s = edit.clone();
        preview.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                if let Some(s) = &s {
                    let mut s = s.clone();
                    s.vol = vol.value() as f32 / 100.;
                    a.load_sound(s, true);
                } else if let Some(path) = path.borrow().clone() {
                    a.stop_preview();
                    a.send(Command::PreviewSound {
                        file: path,
                        start: begin.value() as f32,
                        seconds: length.value() as f32,
                        gain: vol.value() as f32 / 100.,
                        epoch: a.sounds.borrow().preview_epoch,
                    });
                } else {
                    a.toast("Сначала выберите файл");
                }
            }
        });
        let weak = Rc::downgrade(self);
        let s = edit.clone();
        save.connect_clicked(move |b| { if let Some(a) = weak.upgrade() {
            let name = name.text().trim().to_string(); if name.is_empty() { a.toast("Дайте звуку название"); return; }
            let gain = volume.value() as f32 / 100.;
            if let Some(s) = &s {
                a.request("sound-edit", "/api/sounds/edit", Some(json!({"id":s.id[2..].parse::<i64>().unwrap_or(0),"name":name,"emoji":emoji.text().to_string(),"vol":gain})));
            } else if let Some(path) = file.borrow().clone() {
                a.send(Command::UploadSound { file: path, start: start.value() as f32, seconds: seconds.value() as f32, name, emoji: emoji.text().to_string(), gain });
            } else { a.toast("Сначала выберите файл"); return; }
            b.set_sensitive(false); a.toast("Сохраняю звук…");
        } });
        if let Some(sound) = edit {
            let delete = button("Удалить звук", "destructive-action");
            box_.append(&delete);
            let weak = Rc::downgrade(self);
            delete.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    let weak = Rc::downgrade(&a);
                    let id = sound.id[2..].parse::<i64>().unwrap_or(0);
                    a.confirm(
                        "Удалить звук?",
                        "Звук пропадёт из панели у всех.",
                        move || {
                            if let Some(a) = weak.upgrade() {
                                a.request(
                                    "sound-delete",
                                    "/api/sounds/delete",
                                    Some(json!({"id":id})),
                                );
                            }
                        },
                    );
                }
            });
        }
        let weak = Rc::downgrade(self);
        dialog.connect_close_request(move |_| {
            if let Some(a) = weak.upgrade() {
                a.stop_preview();
            }
            glib::Propagation::Proceed
        });
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn sound_response(self: &App, tag: &str, data: Value) {
        let list = soundboard::from_server(data);
        if tag == "sound-list" {
            self.sounds.borrow_mut().list = list;
        } else {
            let me = self.state.borrow().session.as_ref().map(|s| s.me.id);
            self.sounds.borrow_mut().list.retain(|s| s.uid != me);
            self.sounds.borrow_mut().list.extend(list);
            let editor = self.sounds.borrow().editor.upgrade();
            if let Some(editor) = editor {
                editor.close();
            }
            self.toast(if tag == "sound-delete" {
                "Звук удалён"
            } else {
                "Звук сохранён"
            });
        }
        self.draw_soundboard();
    }
    pub(super) fn sound_save_failed(&self) {
        if let Some(save) = self.sounds.borrow().save.upgrade() {
            save.set_sensitive(true);
        }
    }
    pub(super) fn sound_settings(self: &App) -> gtk::Box {
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&box_, 20);
        box_.append(&label("Громкость звуков интерфейса", "heading"));
        let volume = gtk::Scale::with_range(gtk::Orientation::Horizontal, 0., 100., 1.);
        volume.set_value((audio::volume(self.config.borrow().sfx_volume) * 100.) as f64);
        box_.append(&volume);
        let weak = Rc::downgrade(self);
        volume.connect_value_changed(move |v| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().sfx_volume = v.value() as f32 / 100.;
                a.configure_sounds();
                let _ = a.config.borrow().save();
            }
        });
        let mut names = vec!["Системное устройство".to_string()];
        names.extend(audio::outputs());
        let dropdown =
            gtk::DropDown::from_strings(&names.iter().map(String::as_str).collect::<Vec<_>>());
        dropdown.set_selected(
            names
                .iter()
                .position(|n| *n == self.config.borrow().sound_output)
                .unwrap_or(0) as u32,
        );
        box_.append(&label("Динамики для интерфейса и звуковой панели", "muted"));
        box_.append(&dropdown);
        let weak = Rc::downgrade(self);
        dropdown.connect_selected_notify(move |d| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().sound_output = if d.selected() == 0 {
                    String::new()
                } else {
                    names
                        .get(d.selected() as usize)
                        .cloned()
                        .unwrap_or_default()
                };
                a.configure_sounds();
                let _ = a.config.borrow().save();
            }
        });
        for &(group, title, cue) in audio::GROUPS {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            let enabled = gtk::CheckButton::with_label(title);
            enabled.set_active(!self.config.borrow().sfx_off.contains(group));
            enabled.set_hexpand(true);
            let preview = button("▶", "");
            preview.set_tooltip_text(Some("Прослушать"));
            row.append(&enabled);
            row.append(&preview);
            box_.append(&row);
            let weak = Rc::downgrade(self);
            enabled.connect_toggled(move |b| {
                if let Some(a) = weak.upgrade() {
                    {
                        let mut c = a.config.borrow_mut();
                        if b.is_active() {
                            c.sfx_off.remove(group);
                        } else {
                            c.sfx_off.insert(group.into());
                        }
                        let _ = c.save();
                    }
                    a.configure_sounds();
                }
            });
            let weak = Rc::downgrade(self);
            preview.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.audio.play(cue.clip(), 1., Lane::Cue, false);
                }
            });
        }
        let animate = gtk::CheckButton::with_label("Анимировать GIF в чатах и профилях");
        animate.set_active(self.config.borrow().animate_gifs);
        box_.append(&animate);
        let weak = Rc::downgrade(self);
        animate.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().animate_gifs = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        box_
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_gtk_sound_settings_and_stale_playback() {
        gtk::init().expect("GTK display");
        let application = gtk::Application::builder()
            .application_id("app.startrack.tests.sounds")
            .flags(gio::ApplicationFlags::NON_UNIQUE)
            .build();
        application.register(None::<&gio::Cancellable>).unwrap();
        let app = super::super::build_client(&application);
        *app.config.borrow_mut() = Config {
            sfx_volume: 0.,
            soundboard_volume: 0.,
            ..Default::default()
        };
        app.state.borrow_mut().session = Some(Session {
            me: User {
                id: 1,
                ..Default::default()
            },
            ..Default::default()
        });
        app.state.borrow_mut().call = Some(Conversation::User(2));
        // No windows are presented and no audio device is opened by this test.
        assert!(!app.window.is_visible());
        let settings = app.sound_settings();
        assert!(settings.first_child().is_some());
        app.stop_preview();
        let old = app.sounds.borrow().epoch;
        app.stop_board();
        assert_ne!(old, app.sounds.borrow().epoch);
        app.received_sound(old, false, Cue::Message.clip(), 1.);
        app.state.borrow_mut().deaf = true;
        let current = app.sounds.borrow().epoch;
        app.received_sound(current, false, Cue::Message.clip(), 1.);
        app.sync_ringing();
        assert_eq!(app.sounds.borrow().looping, None);
        let rows = gtk::Box::new(gtk::Orientation::Vertical, 0);
        app.sounds.borrow_mut().rows = rows.downgrade();
        app.draw_soundboard();
        let play = rows
            .first_child()
            .unwrap()
            .first_child()
            .unwrap()
            .downcast::<gtk::Button>()
            .unwrap();
        assert!(play.label().unwrap().contains("Гудок"));
        app.sounds.borrow_mut().favorites_only = true;
        app.draw_soundboard();
        assert!(rows.first_child().unwrap().is::<gtk::Label>());
        app.reset_sounds();
        assert!(app.verity_settings().first_child().is_some());
        assert!(app.update_settings().first_child().is_some());
        assert!(app.activity_settings().first_child().is_some());
        let controls = app.playback_settings(Some("2"));
        let voice = controls
            .first_child()
            .unwrap()
            .next_sibling()
            .unwrap()
            .downcast::<gtk::Scale>()
            .unwrap();
        let screen = voice
            .next_sibling()
            .unwrap()
            .next_sibling()
            .unwrap()
            .downcast::<gtk::Scale>()
            .unwrap();
        assert_eq!(voice.value(), 100.);
        assert_eq!(screen.value(), 100.);
        app.socket_event(
            json!({"type":"game", "userId":1, "game":{"name":"Native Test", "start":1}}),
        );
        let me = app.state.borrow().session.as_ref().unwrap().me.clone();
        let activity = app.activity_label(me, true);
        assert!(activity.text().contains("Native Test"));
        app.socket_event(json!({"type":"game", "userId":1, "game":null}));
        assert!(app
            .state
            .borrow()
            .session
            .as_ref()
            .unwrap()
            .me
            .game
            .is_none());
        app.config.borrow_mut().verity_pc = "off".into();
        // Rejected remote tools do not start any local process; stale results are ignored.
        app.verity_response(8, &json!({"pending":{"turn":"test-turn","calls":[{"id":"a","name":"run_command","args":{"command":"MUST NOT RUN"}}]}}));
        assert!(app.state.borrow().verity_busy);
        app.cancel_verity();
        app.verity_tool_done("test-turn".into(), "a".into(), Ok("stale".into()));
        assert!(app.verity.borrow().turn.is_empty());
        app.send(Command::Shutdown);
        app.window.destroy();
    }
}
