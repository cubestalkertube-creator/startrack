use super::*;

impl Client {
    pub(super) fn activity_settings(self: &App) -> gtk::Box {
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let enabled = gtk::CheckButton::with_label("Показывать, во что я играю");
        enabled.set_active(self.config.borrow().show_games);
        box_.append(&enabled);
        let hint = label(
            "Друзья увидят игру и время в ней. Обновляется каждые 15 секунд.",
            "muted",
        );
        hint.set_wrap(true);
        box_.append(&hint);
        let weak = Rc::downgrade(self);
        enabled.connect_toggled(move |button| {
            if let Some(app) = weak.upgrade() {
                let on = button.is_active();
                app.config.borrow_mut().show_games = on;
                let _ = app.config.borrow().save();
                app.send(Command::Games(on));
            }
        });
        box_
    }

    pub(super) fn activity_label(self: &App, user: User, detail: bool) -> gtk::Label {
        let label = label("", "muted");
        label.set_xalign(0.);
        label.set_wrap(true);
        label.set_max_width_chars(if detail { 42 } else { 24 });
        let account = self.state.borrow().session.as_ref().map(|s| s.me.id);
        update(&label, &user, account.unwrap_or(0), detail);
        let widget = label.downgrade();
        let weak = Rc::downgrade(self);
        glib::timeout_add_local(Duration::from_secs(1), move || {
            let (Some(app), Some(label)) = (weak.upgrade(), widget.upgrade()) else {
                return glib::ControlFlow::Break;
            };
            let state = app.state.borrow();
            let Some(session) = state.session.as_ref().filter(|s| Some(s.me.id) == account) else {
                label.set_text("");
                label.set_visible(false);
                return glib::ControlFlow::Break;
            };
            update(
                &label,
                session.user(user.id).unwrap_or(&user),
                session.me.id,
                detail,
            );
            glib::ControlFlow::Continue
        });
        label
    }
}

fn update(label: &gtk::Label, user: &User, me: i64, detail: bool) {
    if let Some(game) = user.visible_game(me) {
        label.set_text(&if detail {
            format!(
                "Играет в {}\n{}",
                game.name,
                game.elapsed(chrono::Utc::now().timestamp_millis())
            )
        } else {
            format!("Играет в {}", game.name)
        });
        label.set_visible(true);
    } else {
        label.set_text("");
        label.set_visible(false);
    }
}
