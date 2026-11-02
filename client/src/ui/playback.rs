use super::*;

impl Client {
    pub(super) fn playback_settings(self: &App, identity: Option<&str>) -> gtk::Box {
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
        let controls = if let Some(id) = identity {
            vec![
                ("Голос участника", Some(crate::playback::key(id, false))),
                ("Звук демонстрации", Some(crate::playback::key(id, true))),
            ]
        } else {
            vec![("Общая громкость звонка", None)]
        };
        for (title, key) in controls {
            box_.append(&label(title, "heading"));
            let value = {
                let config = self.config.borrow();
                key.as_ref()
                    .map(|key| config.user_volumes.get(key).copied().unwrap_or(1.))
                    .unwrap_or(config.volume)
            };
            let slider = gtk::Scale::with_range(gtk::Orientation::Horizontal, 0., 200., 1.);
            slider.set_draw_value(true);
            slider.set_digits(0);
            slider.set_value(f64::from(crate::playback::level(value)) * 100.);
            slider.add_mark(100., gtk::PositionType::Bottom, Some("100%"));
            slider.set_hexpand(true);
            box_.append(&slider);
            let weak = Rc::downgrade(self);
            slider.connect_value_changed(move |slider| {
                if let Some(app) = weak.upgrade() {
                    let playback = {
                        let mut config = app.config.borrow_mut();
                        let value = crate::playback::level(slider.value() as f32 / 100.);
                        if let Some(key) = &key {
                            config.user_volumes.insert(key.clone(), value);
                        } else {
                            config.volume = value;
                        }
                        if let Err(error) = config.save() {
                            app.toast(&error.to_string());
                        }
                        crate::playback::Playback::from_config(&config)
                    };
                    app.media(media::Command::Volumes(playback));
                }
            });
        }
        box_.append(&label(
            "Применяется сразу. Громкость указана в процентах.",
            "muted",
        ));
        box_
    }

    pub(super) fn participant_volume(self: &App, identity: &str) {
        let name = self
            .state
            .borrow()
            .session
            .as_ref()
            .and_then(|s| identity.parse().ok().and_then(|id| s.user(id)))
            .map(|u| u.name().to_owned())
            .unwrap_or_else(|| identity.to_owned());
        let dialog = self.dialog(&format!("Громкость · {name}"), 430, 280);
        let controls = self.playback_settings(Some(identity));
        margins(&controls, 20);
        dialog.set_child(Some(&controls));
        dialog.present();
    }
}
