use super::*;

impl Client {
    pub(super) fn settings(self: &App) {
        let dialog = self.dialog("Настройки", 680, 650);
        let tabs = gtk::Notebook::new();
        dialog.set_child(Some(&tabs));
        let profile = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&profile, 20);
        let me = self
            .state
            .borrow()
            .session
            .as_ref()
            .map(|s| s.me.clone())
            .unwrap_or_default();
        let display = field(&profile, "Отображаемое имя", &me.display);
        let pronouns = field(&profile, "Местоимения", &me.pronouns);
        let bio = field(&profile, "Обо мне", &me.bio);
        let custom = field(&profile, "Свой статус", &me.custom);
        let color = field(&profile, "Цвет баннера (#RRGGBB)", &me.bcolor);
        for kind in ["avatar", "banner"] {
            let b = button(
                if kind == "avatar" {
                    "Загрузить аватарку…"
                } else {
                    "Загрузить баннер…"
                },
                "",
            );
            profile.append(&b);
            let weak = Rc::downgrade(self);
            b.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    let picker = gtk::FileChooserNative::builder()
                        .title("Выберите изображение")
                        .transient_for(&a.window)
                        .action(gtk::FileChooserAction::Open)
                        .build();
                    let filter = gtk::FileFilter::new();
                    filter.add_mime_type("image/png");
                    filter.add_mime_type("image/jpeg");
                    filter.add_mime_type("image/gif");
                    filter.add_mime_type("image/webp");
                    picker.add_filter(&filter);
                    let weak = Rc::downgrade(&a);
                    picker.connect_response(move |d, r| {
                        if r == gtk::ResponseType::Accept {
                            if let (Some(a), Some(file)) =
                                (weak.upgrade(), d.file().and_then(|f| f.path()))
                            {
                                a.send(Command::PrepareImage {
                                    kind: kind.into(),
                                    file,
                                });
                            }
                        }
                        d.destroy();
                    });
                    picker.show();
                }
            });
        }
        let save = button("Сохранить профиль", "suggested-action");
        profile.append(&save);
        let weak = Rc::downgrade(self);
        save.connect_clicked(move |_|{if let Some(a)=weak.upgrade(){a.request("me","/api/me/profile",Some(json!({"display":display.text().to_string(),"pronouns":pronouns.text().to_string(),"bio":bio.text().to_string(),"custom":custom.text().to_string(),"bcolor":color.text().to_string()})));a.toast("Сохраняю профиль…");}});
        tabs.append_page(&profile, Some(&label("Профиль", "")));
        let application = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&application, 20);
        application.append(&label("Startrack · нативный клиент", "title"));
        application.append(&label(
            &format!("Версия {} · Rust + gtk-rs", env!("CARGO_PKG_VERSION")),
            "muted",
        ));
        let server = field(&application, "Сервер", &self.config.borrow().server);
        server.set_editable(false);
        let light = gtk::CheckButton::with_label("Светлая тема");
        light.set_active(self.config.borrow().theme == "light");
        application.append(&light);
        let weak = Rc::downgrade(self);
        light.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().theme = if b.is_active() { "light" } else { "dark" }.into();
                if b.is_active() {
                    a.window.add_css_class("light");
                } else {
                    a.window.remove_css_class("light");
                }
                if let Err(e) = a.config.borrow().save() {
                    a.toast(&e.to_string());
                }
            }
        });
        let notifications = gtk::CheckButton::with_label("Уведомления о сообщениях");
        notifications.set_active(self.config.borrow().notifications);
        application.append(&notifications);
        let weak = Rc::downgrade(self);
        notifications.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().notifications = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        application.append(&self.activity_settings());
        let tray = gtk::CheckButton::with_label(
            "Закрывать окно в трей (сообщения и звонки продолжают работать)",
        );
        tray.set_active(self.config.borrow().close_to_tray);
        application.append(&tray);
        let weak = Rc::downgrade(self);
        tray.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().close_to_tray = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        let startup = gtk::CheckButton::with_label("Запускать Startrack при входе в систему");
        startup.set_active(self.config.borrow().autostart);
        application.append(&startup);
        let weak = Rc::downgrade(self);
        startup.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                match crate::desktop::set_autostart(b.is_active()) {
                    Ok(()) => {
                        a.config.borrow_mut().autostart = b.is_active();
                        let _ = a.config.borrow().save();
                    }
                    Err(e) => {
                        a.toast(&format!("Автозапуск: {e}"));
                        let previous = a.config.borrow().autostart;
                        b.set_active(previous);
                    }
                }
            }
        });
        application.append(&self.update_settings());
        let quit = button("Завершить Startrack", "");
        application.append(&quit);
        let weak = Rc::downgrade(self);
        quit.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.quit();
            }
        });
        let logout = button("Выйти из аккаунта", "destructive-action");
        application.append(&logout);
        let weak = Rc::downgrade(self);
        let dialog_clone = dialog.clone();
        logout.connect_clicked(move |_| {
            dialog_clone.close();
            if let Some(a) = weak.upgrade() {
                a.logout();
            }
        });
        tabs.append_page(
            &gtk::ScrolledWindow::builder()
                .child(&application)
                .hscrollbar_policy(gtk::PolicyType::Never)
                .build(),
            Some(&label("Приложение", "")),
        );
        let voice = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&voice, 20);
        voice.append(&label("Голос и демонстрация экрана", "heading"));
        voice.append(&self.playback_settings(None));
        let devices = button("Выбрать микрофон и динамики…", "");
        voice.append(&devices);
        let weak = Rc::downgrade(self);
        devices.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.media(media::Command::Devices);
            }
        });
        let noise = gtk::CheckButton::with_label("Шумоподавление и эхокомпенсация");
        noise.set_active(self.config.borrow().noise_suppression);
        voice.append(&noise);
        let weak = Rc::downgrade(self);
        noise.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().noise_suppression = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        let relay = gtk::CheckButton::with_label("TURN / TCP (для VPN и сложных сетей)");
        relay.set_active(self.config.borrow().relay);
        voice.append(&relay);
        let weak = Rc::downgrade(self);
        relay.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().relay = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        voice.append(&label(
            "Изменения устройств применяются к следующему звонку.",
            "muted",
        ));
        let quality = gtk::DropDown::from_strings(&[
            "720p · 30 fps",
            "1080p · 30 fps",
            "1080p · 60 fps",
            "1440p · 60 fps",
        ]);
        quality.set_selected(
            match (
                self.config.borrow().screen_height,
                self.config.borrow().screen_fps,
            ) {
                (720, _) => 0,
                (1080, 60) => 2,
                (1440, _) => 3,
                _ => 1,
            },
        );
        voice.append(&quality);
        let weak = Rc::downgrade(self);
        quality.connect_selected_notify(move |d| {
            if let Some(a) = weak.upgrade() {
                let (h, f) = match d.selected() {
                    0 => (720, 30),
                    2 => (1080, 60),
                    3 => (1440, 60),
                    _ => (1080, 30),
                };
                a.config.borrow_mut().screen_height = h;
                a.config.borrow_mut().screen_fps = f;
                let _ = a.config.borrow().save();
            }
        });
        tabs.append_page(&voice, Some(&label("Голос", "")));
        let sounds = gtk::ScrolledWindow::builder()
            .child(&self.sound_settings())
            .build();
        tabs.append_page(&sounds, Some(&label("Звуки", "")));
        let verity = self.verity_settings();
        tabs.append_page(&verity, Some(&label("Верити", "")));
        let security = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&security, 20);
        let old = gtk::PasswordEntry::builder()
            .placeholder_text("Текущий пароль")
            .build();
        let new = gtk::PasswordEntry::builder()
            .placeholder_text("Новый пароль")
            .build();
        security.append(&old);
        security.append(&new);
        let change = button("Изменить пароль", "suggested-action");
        security.append(&change);
        let weak = Rc::downgrade(self);
        change.connect_clicked(move |_|{if let Some(a)=weak.upgrade(){a.request("password","/api/me/password",Some(json!({"oldPassword":old.text().to_string(),"newPassword":new.text().to_string()})));}});
        tabs.append_page(&security, Some(&label("Безопасность", "")));
        dialog.present();
    }
    pub(super) fn self_menu(self: &App) {
        let dialog = self.dialog("Мой статус", 320, 300);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&box_, 20);
        for (status, title) in [
            ("online", "В сети"),
            ("idle", "Неактивен"),
            ("dnd", "Не беспокоить"),
            ("invisible", "Невидимый"),
        ] {
            let b = button(title, "");
            box_.append(&b);
            let weak = Rc::downgrade(self);
            let dialog = dialog.clone();
            b.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.request("me", "/api/me/status", Some(json!({"status":status})));
                }
                dialog.close();
            });
        }
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn profile_dialog(self: &App, data: Value) {
        let Ok(user) = serde_json::from_value::<User>(data.clone()) else {
            return;
        };
        let dialog = self.dialog("Профиль", 420, 480);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&box_, 24);
        if !user.banner.is_empty() {
            box_.append(&self.image(&format!("/api/avatars/{}", user.banner), 360, 120));
        }
        if !user.avatar.is_empty() {
            box_.append(&self.image(&format!("/api/avatars/{}", user.avatar), 80, 80));
        }
        box_.append(&label(user.name(), "title"));
        box_.append(&label(
            &format!("@{} · {}", user.username, user.status_label()),
            "muted",
        ));
        box_.append(&label(&user.pronouns, "muted"));
        let bio = label(&user.bio, "");
        bio.set_wrap(true);
        bio.set_selectable(true);
        box_.append(&bio);
        box_.append(&label(&user.custom, ""));
        box_.append(&self.activity_label(user.clone(), true));
        box_.append(&label(
            &format!(
                "Общих друзей: {} · Общих групп: {}",
                data["mutualFriends"].as_array().map(Vec::len).unwrap_or(0),
                data["mutualGroups"].as_array().map(Vec::len).unwrap_or(0)
            ),
            "muted",
        ));
        let dm = button("Написать сообщение", "suggested-action");
        box_.append(&dm);
        let weak = Rc::downgrade(self);
        dm.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.select(Some(Conversation::User(user.id)));
            }
        });
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn group_dialog(self: &App, group: Option<i64>) {
        let dialog = self.dialog(
            if group.is_some() {
                "Добавить участников"
            } else {
                "Создать группу"
            },
            420,
            500,
        );
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 10);
        margins(&box_, 20);
        let name = field(&box_, "Название группы", "");
        name.set_visible(group.is_none());
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        let existing = session
            .groups
            .iter()
            .find(|g| Some(g.id) == group)
            .map(|g| g.members.iter().map(|u| u.id).collect::<Vec<_>>())
            .unwrap_or_default();
        let mut checks = vec![];
        for u in session
            .friends
            .friends
            .iter()
            .filter(|u| !existing.contains(&u.id))
        {
            let check = gtk::CheckButton::with_label(u.name());
            box_.append(&check);
            checks.push((u.id, check));
        }
        drop(state);
        let go = button(
            if group.is_some() {
                "Добавить"
            } else {
                "Создать"
            },
            "suggested-action",
        );
        box_.append(&go);
        let weak = Rc::downgrade(self);
        let dialog_clone = dialog.clone();
        go.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                let users: Vec<_> = checks
                    .iter()
                    .filter(|(_, c)| c.is_active())
                    .map(|(id, _)| *id)
                    .collect();
                if users.is_empty() {
                    a.toast("Выберите хотя бы одного друга");
                    return;
                }
                a.request(
                    "group-change",
                    if group.is_some() {
                        "/api/groups/add"
                    } else {
                        "/api/groups/create"
                    },
                    Some(json!({"group":group,"name":name.text().to_string(),"users":users})),
                );
                dialog_clone.close();
            }
        });
        let scroll = gtk::ScrolledWindow::builder().child(&box_).build();
        dialog.set_child(Some(&scroll));
        dialog.present();
    }
    pub(super) fn group_members(self: &App, conv: Conversation) {
        let Conversation::Group(id) = conv else {
            return;
        };
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        let Some(group) = session.groups.iter().find(|g| g.id == id) else {
            return;
        };
        let dialog = self.dialog(&group.title(), 400, 500);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        margins(&box_, 20);
        for user in &group.members {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            let name = label(
                &format!(
                    "{}{}",
                    user.name(),
                    if user.id == group.owner { " ♛" } else { "" }
                ),
                "heading",
            );
            name.set_hexpand(true);
            row.append(&name);
            self.user_menu(&row, user.id);
            if group.owner == session.me.id && user.id != session.me.id {
                let kick = button("Исключить", "");
                row.append(&kick);
                let uid = user.id;
                let weak = Rc::downgrade(self);
                kick.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        let weak = Rc::downgrade(&a);
                        a.confirm(
                            "Исключить участника?",
                            "Он сможет вернуться по новому приглашению.",
                            move || {
                                if let Some(a) = weak.upgrade() {
                                    a.request(
                                        "group-change",
                                        "/api/groups/remove",
                                        Some(json!({"group":id,"user":uid})),
                                    );
                                }
                            },
                        );
                    }
                });
            }
            box_.append(&row);
        }
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn emoji_picker(self: &App, anchor: &gtk::Button) {
        let pop = gtk::Popover::new();
        pop.set_parent(anchor);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let search = gtk::SearchEntry::builder()
            .placeholder_text("Поиск эмодзи")
            .build();
        box_.append(&search);
        let flow = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .max_children_per_line(8)
            .min_children_per_line(6)
            .build();
        let scroll = gtk::ScrolledWindow::builder()
            .min_content_width(350)
            .min_content_height(280)
            .max_content_height(380)
            .child(&flow)
            .build();
        box_.append(&scroll);
        pop.set_child(Some(&box_));
        let data: Value =
            serde_json::from_str(include_str!("../emoji.json")).unwrap_or(Value::Null);
        let rows = data["list"].as_array().cloned().unwrap_or_default();
        let weak = Rc::downgrade(self);
        let pop_weak = pop.downgrade();
        let draw = Rc::new(move |query: &str| {
            while let Some(child) = flow.first_child() {
                flow.remove(&child);
            }
            let query = query.to_lowercase();
            for row in rows
                .iter()
                .filter(|r| {
                    query.is_empty()
                        || r[2].as_str().unwrap_or_default().contains(&query)
                        || r[3].as_str().unwrap_or_default().contains(&query)
                })
                .take(120)
            {
                let emoji = row[0].as_str().unwrap_or_default().to_string();
                let b = button(&emoji, "");
                b.set_tooltip_text(row[2].as_str());
                let weak = weak.clone();
                let pop = pop_weak.clone();
                b.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        a.composer.buffer().insert_at_cursor(&emoji);
                        a.composer.grab_focus();
                    }
                    if let Some(p) = pop.upgrade() {
                        p.popdown();
                    }
                });
                flow.insert(&b, -1);
            }
        });
        draw("");
        let draw_clone = draw.clone();
        search.connect_search_changed(move |e| draw_clone(e.text().as_str()));
        pop.connect_closed(|p| p.unparent());
        pop.popup();
    }
    pub(super) fn gif_dialog(self: &App, data: Value) {
        let dialog = self.dialog("Избранные GIF", 500, 400);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        margins(&box_, 20);
        if let Some(list) = data.as_array() {
            for (index, gif) in list.iter().enumerate() {
                let Some(hash) = gif["hash"].as_str() else {
                    continue;
                };
                let b = button(&format!("Отправить GIF {}", index + 1), "");
                box_.append(&b);
                let hash = hash.to_string();
                let weak = Rc::downgrade(self);
                let dialog = dialog.clone();
                b.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        if let Some(c) = a.state.borrow().selected {
                            let mut body = c.target();
                            body["hash"] = json!(hash);
                            a.request("upload", "/api/gifs/send", Some(body));
                            dialog.close();
                        }
                    }
                });
            }
        }
        if box_.first_child().is_none() {
            box_.append(&label("У вас пока нет избранных GIF", "muted"));
        }
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn verity_chats(self: &App) {
        let dialog = self.dialog("Чаты с Верити", 420, 480);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        margins(&box_, 16);
        for chat in &self.state.borrow().verity_chats {
            let id = chat["id"].as_i64().unwrap_or_default();
            let b = button(chat["title"].as_str().unwrap_or("Новый чат"), "");
            box_.append(&b);
            let weak = Rc::downgrade(self);
            let dialog = dialog.clone();
            b.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.select(Some(Conversation::Verity(id)));
                    dialog.close();
                }
            });
        }
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn screen_dialog(self: &App) {
        let dialog = self.dialog("Что показать?", 520, 500);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        margins(&box_, 20);
        box_.append(&label("Выберите экран или окно", "heading"));
        let audio = gtk::CheckButton::with_label("Передавать системный звук вместе с экраном");
        box_.append(&audio);
        let info = label(
            if cfg!(windows) {
                "Системный звук: Windows 11 / Windows 10 build 20348+. Звуки Startrack исключаются. Передаются звуки всех остальных приложений."
            } else {
                "Передаются все звуки системного выхода, включая звук звонка. Для изоляции приложений используйте отдельный выход PulseAudio/PipeWire."
            },
            "muted",
        );
        info.set_wrap(true);
        box_.append(&info);
        let mut targets = vec![];
        if let Ok(monitors) = xcap::Monitor::all() {
            for m in monitors {
                if let Ok(id) = m.id() {
                    targets.push((
                        false,
                        id,
                        format!("Экран: {}", m.friendly_name().unwrap_or_default()),
                    ));
                }
            }
        }
        if let Ok(windows) = xcap::Window::all() {
            for w in windows {
                if let (Ok(id), Ok(title)) = (w.id(), w.title()) {
                    if !title.is_empty() {
                        targets.push((true, id, title));
                    }
                }
            }
        }
        for (window, id, title) in targets {
            let b = button(&title, "");
            box_.append(&b);
            let weak = Rc::downgrade(self);
            let dialog = dialog.clone();
            let audio = audio.clone();
            b.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    let config = a.config.borrow();
                    a.media(media::Command::Screen {
                        window,
                        id,
                        height: config.screen_height,
                        fps: config.screen_fps,
                        audio: audio.is_active(),
                    });
                    dialog.close();
                }
            });
        }
        let scroll = gtk::ScrolledWindow::builder().child(&box_).build();
        dialog.set_child(Some(&scroll));
        dialog.present();
    }
    pub(super) fn audio_devices(
        self: &App,
        microphones: Vec<(String, String)>,
        outputs: Vec<(String, String)>,
    ) {
        let dialog = self.dialog("Аудиоустройства", 500, 320);
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&box_, 20);
        for (mic, list) in [(true, microphones), (false, outputs)] {
            box_.append(&label(
                if mic {
                    "Микрофон"
                } else {
                    "Динамики"
                },
                "heading",
            ));
            let mut names = vec!["Системное устройство".to_string()];
            names.extend(list.iter().map(|(_, name)| name.clone()));
            let refs: Vec<_> = names.iter().map(String::as_str).collect();
            let choice = gtk::DropDown::from_strings(&refs);
            let selected = if mic {
                self.config.borrow().microphone.clone()
            } else {
                self.config.borrow().output.clone()
            };
            choice.set_selected(
                list.iter()
                    .position(|(id, _)| *id == selected)
                    .map(|i| i as u32 + 1)
                    .unwrap_or(0),
            );
            let weak = Rc::downgrade(self);
            choice.connect_selected_notify(move |d| {
                if let Some(a) = weak.upgrade() {
                    let value = d
                        .selected()
                        .checked_sub(1)
                        .and_then(|i| list.get(i as usize))
                        .map(|(id, _)| id.clone())
                        .unwrap_or_default();
                    if mic {
                        a.config.borrow_mut().microphone = value;
                    } else {
                        a.config.borrow_mut().output = value;
                    }
                    let _ = a.config.borrow().save();
                }
            });
            box_.append(&choice);
        }
        dialog.set_child(Some(&box_));
        dialog.present();
    }
    pub(super) fn dialog(&self, title: &str, width: i32, height: i32) -> gtk::Window {
        gtk::Window::builder()
            .title(title)
            .transient_for(&self.window)
            .default_width(width)
            .default_height(height)
            .build()
    }
}
pub(super) fn field(parent: &gtk::Box, title: &str, value: &str) -> gtk::Entry {
    let label = label(title, "muted");
    label.set_xalign(0.);
    parent.append(&label);
    let entry = gtk::Entry::builder().text(value).build();
    parent.append(&entry);
    entry
}
