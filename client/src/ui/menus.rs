use super::*;

#[derive(Clone)]
enum Action {
    Open(Conversation),
    Call(Conversation),
    Profile(i64),
    Copy(String),
    Reply(String),
    Delete(i64),
    Save(Attachment),
    RemoveFriend(i64),
    RenameGroup(i64),
    AddGroup(i64),
    LeaveGroup(i64),
    MuteUser(String),
    VolumeUser(String),
    WatchUser(String),
    StopWatching(String),
    Fullscreen,
}

impl Client {
    /// Each row owns an action group; the popover is transient and released on close.
    /// GTK handles keyboard navigation, Escape, focus, and keeping the menu on screen.
    fn context_menu(self: &App, widget: &impl IsA<gtk::Widget>, items: Vec<(String, Action)>) {
        let model = gio::Menu::new();
        let group = gio::SimpleActionGroup::new();
        for (i, (title, action)) in items.into_iter().enumerate() {
            let name = format!("item{i}");
            let handler = gio::SimpleAction::new(&name, None);
            let weak = Rc::downgrade(self);
            handler.connect_activate(move |_, _| {
                if let Some(app) = weak.upgrade() {
                    app.context_action(action.clone());
                }
            });
            group.add_action(&handler);
            model.append(Some(&title), Some(&format!("ctx.{name}")));
        }
        widget.insert_action_group("ctx", Some(&group));
        let gesture = gtk::GestureClick::new();
        gesture.set_button(3);
        gesture.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = widget.as_ref().downgrade();
        let model_clone = model.clone();
        gesture.connect_pressed(move |g, _, x, y| {
            if let Some(widget) = weak.upgrade() {
                popup(&widget, &model_clone, x, y);
                g.set_state(gtk::EventSequenceState::Claimed);
            }
        });
        widget.add_controller(gesture);
        let key = gtk::EventControllerKey::new();
        let weak = widget.as_ref().downgrade();
        key.connect_key_pressed(move |_, key, _, mods| {
            if key == gdk::Key::Menu
                || (key == gdk::Key::F10 && mods.contains(gdk::ModifierType::SHIFT_MASK))
            {
                if let Some(widget) = weak.upgrade() {
                    popup(&widget, &model, 12., 12.);
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        widget.add_controller(key);
        widget.set_focusable(true);
    }
    pub(super) fn conversation_menu(
        self: &App,
        widget: &impl IsA<gtk::Widget>,
        conv: Conversation,
    ) {
        let mut items = vec![("Открыть беседу".into(), Action::Open(conv))];
        match conv {
            Conversation::User(id) => {
                items.extend([
                    ("Позвонить".into(), Action::Call(conv)),
                    ("Профиль".into(), Action::Profile(id)),
                    ("Копировать ID".into(), Action::Copy(id.to_string())),
                    ("Удалить из друзей…".into(), Action::RemoveFriend(id)),
                ]);
            }
            Conversation::Group(id) => {
                items.extend([
                    ("Позвонить в группе".into(), Action::Call(conv)),
                    ("Переименовать…".into(), Action::RenameGroup(id)),
                    ("Добавить участников…".into(), Action::AddGroup(id)),
                    ("Покинуть группу…".into(), Action::LeaveGroup(id)),
                ]);
            }
            Conversation::Verity(_) => {}
        }
        self.context_menu(widget, items);
    }
    pub(super) fn user_menu(self: &App, widget: &impl IsA<gtk::Widget>, id: i64) {
        self.context_menu(
            widget,
            vec![
                ("Профиль".into(), Action::Profile(id)),
                (
                    "Написать сообщение".into(),
                    Action::Open(Conversation::User(id)),
                ),
                ("Позвонить".into(), Action::Call(Conversation::User(id))),
                ("Копировать ID".into(), Action::Copy(id.to_string())),
            ],
        );
    }
    pub(super) fn call_user_menu(self: &App, widget: &impl IsA<gtk::Widget>, id: i64) {
        let mut items = vec![
            ("Профиль".into(), Action::Profile(id)),
            (
                "Написать сообщение".into(),
                Action::Open(Conversation::User(id)),
            ),
        ];
        if self
            .state
            .borrow()
            .session
            .as_ref()
            .is_some_and(|s| s.me.id != id)
        {
            items.push((
                "Громкость голоса и демонстрации…".into(),
                Action::VolumeUser(id.to_string()),
            ));
            items.push((
                "Включить / отключить звук пользователя".into(),
                Action::MuteUser(id.to_string()),
            ));
            items.push((
                "Смотреть демонстрации пользователя".into(),
                Action::WatchUser(id.to_string()),
            ));
        }
        self.context_menu(widget, items);
    }
    pub(super) fn video_menu(self: &App, widget: &impl IsA<gtk::Widget>, sid: &str, id: &str) {
        self.context_menu(
            widget,
            vec![
                (
                    "Перестать смотреть".into(),
                    Action::StopWatching(sid.into()),
                ),
                (
                    "Включить / отключить звук пользователя".into(),
                    Action::MuteUser(id.into()),
                ),
                ("Во весь экран".into(), Action::Fullscreen),
                (
                    "Громкость голоса и демонстрации…".into(),
                    Action::VolumeUser(id.into()),
                ),
            ],
        );
    }
    pub(super) fn message_menu(self: &App, widget: &impl IsA<gtk::Widget>, m: &Message, me: i64) {
        let mut items = vec![
            ("Копировать текст".into(), Action::Copy(m.text.clone())),
            (
                "Копировать ID сообщения".into(),
                Action::Copy(m.id.to_string()),
            ),
        ];
        if m.kind.is_none() {
            items.push(("Ответить".into(), Action::Reply(m.text.clone())));
        }
        if let Some(file) = &m.file {
            items.push(("Сохранить вложение…".into(), Action::Save(file.clone())));
        }
        if m.sender == me && m.kind.is_none() {
            items.push(("Удалить у всех…".into(), Action::Delete(m.id)));
        }
        self.context_menu(widget, items);
    }
    fn context_action(self: &App, action: Action) {
        match action {
            Action::Open(c) => self.select(Some(c)),
            Action::Call(c) => self.call(c, false),
            Action::Profile(id) => self.request(
                format!("profile:{id}"),
                format!("/api/users/profile?id={id}"),
                None,
            ),
            Action::Copy(text) => {
                self.window.clipboard().set_text(&text);
                self.toast("Скопировано");
            }
            Action::Reply(text) => {
                let quoted = text
                    .lines()
                    .map(|s| format!("> {s}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                self.composer.buffer().set_text(&format!("{quoted}\n\n"));
                self.composer.grab_focus();
                let b = self.composer.buffer();
                b.place_cursor(&b.end_iter());
            }
            Action::Delete(id) => {
                let allowed = self.state.borrow().session.as_ref().is_some_and(|s| {
                    s.messages
                        .values()
                        .flatten()
                        .any(|m| m.id == id && m.sender == s.me.id && m.kind.is_none())
                });
                if !allowed {
                    return;
                }
                let weak = Rc::downgrade(self);
                self.confirm(
                    "Удалить сообщение у всех?",
                    "Восстановить сообщение будет нельзя.",
                    move || {
                        if let Some(a) = weak.upgrade() {
                            a.request("delete", "/api/messages/delete", Some(json!({"id":id})));
                        }
                    },
                );
            }
            Action::Save(file) => self.save_file(&file),
            Action::RemoveFriend(id) => {
                let weak = Rc::downgrade(self);
                self.confirm(
                    "Удалить из друзей?",
                    "Чтобы общаться снова, потребуется новая заявка.",
                    move || {
                        if let Some(a) = weak.upgrade() {
                            a.request("friends", "/api/friends/remove", Some(json!({"userId":id})));
                        }
                    },
                );
            }
            Action::RenameGroup(id) => {
                let name = self
                    .state
                    .borrow()
                    .session
                    .as_ref()
                    .and_then(|s| s.groups.iter().find(|g| g.id == id))
                    .map(|g| g.name.clone())
                    .unwrap_or_default();
                let weak = Rc::downgrade(self);
                self.prompt("Название группы", &name, move |name| {
                    if let Some(a) = weak.upgrade() {
                        a.request(
                            "group-change",
                            "/api/groups/rename",
                            Some(json!({"group":id,"name":name})),
                        );
                    }
                });
            }
            Action::AddGroup(id) => self.group_dialog(Some(id)),
            Action::LeaveGroup(id) => {
                let weak = Rc::downgrade(self);
                self.confirm(
                    "Покинуть группу?",
                    "Вернуться можно по приглашению участника.",
                    move || {
                        if let Some(a) = weak.upgrade() {
                            a.request(
                                "group-change",
                                "/api/groups/remove",
                                Some(json!({"group":id})),
                            );
                            if a.state.borrow().selected == Some(Conversation::Group(id)) {
                                a.select(None);
                            }
                            if a.state.borrow().call == Some(Conversation::Group(id)) {
                                a.hangup(true);
                            }
                        }
                    },
                );
            }
            Action::MuteUser(identity) => {
                let muted = !self
                    .state
                    .borrow()
                    .user_mutes
                    .get(&identity)
                    .copied()
                    .unwrap_or(false);
                self.state
                    .borrow_mut()
                    .user_mutes
                    .insert(identity.clone(), muted);
                self.media(media::Command::MuteUser { identity, muted });
                if muted {
                    self.stop_board();
                }
            }
            Action::WatchUser(identity) => self.media(media::Command::Subscribe {
                sid: format!("user:{identity}"),
                enabled: true,
            }),
            Action::VolumeUser(identity) => self.participant_volume(&identity),
            Action::StopWatching(sid) => self.media(media::Command::Subscribe {
                sid,
                enabled: false,
            }),
            Action::Fullscreen => {
                if self.window.is_fullscreen() {
                    self.window.unfullscreen();
                } else {
                    self.window.fullscreen();
                }
            }
        }
    }
    pub(super) fn confirm(self: &App, title: &str, body: &str, callback: impl Fn() + 'static) {
        let dialog = gtk::MessageDialog::builder()
            .transient_for(&self.window)
            .modal(true)
            .message_type(gtk::MessageType::Question)
            .text(title)
            .secondary_text(body)
            .build();
        dialog.add_button("Отмена", gtk::ResponseType::Cancel);
        dialog.add_button("Подтвердить", gtk::ResponseType::Accept);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        dialog.connect_response(move |d, r| {
            if r == gtk::ResponseType::Accept {
                callback();
            }
            d.close();
        });
        dialog.present();
    }
    pub(super) fn prompt(
        self: &App,
        title: &str,
        value: &str,
        callback: impl Fn(String) + 'static,
    ) {
        let dialog = gtk::Dialog::builder()
            .title(title)
            .transient_for(&self.window)
            .modal(true)
            .default_width(380)
            .build();
        let entry = gtk::Entry::builder().text(value).max_length(100).build();
        margins(&entry, 16);
        dialog.content_area().append(&entry);
        dialog.add_button("Отмена", gtk::ResponseType::Cancel);
        dialog.add_button("Сохранить", gtk::ResponseType::Accept);
        dialog.connect_response(move |d, r| {
            if r == gtk::ResponseType::Accept {
                callback(entry.text().trim().to_string());
            }
            d.close();
        });
        dialog.present();
    }
}
fn popup(widget: &gtk::Widget, model: &gio::Menu, x: f64, y: f64) {
    let menu = gtk::PopoverMenu::from_model(Some(model));
    menu.set_parent(widget);
    menu.set_has_arrow(false);
    menu.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
    menu.connect_closed(|p| p.unparent());
    menu.popup();
}
