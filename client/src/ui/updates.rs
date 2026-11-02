use super::*;
#[derive(Default)]
pub(super) struct Updates {
    pending: Option<crate::update::Release>,
    prepared: Option<crate::update::Prepared>,
    busy: bool,
    message: String,
    label: glib::WeakRef<gtk::Label>,
}
impl Client {
    fn update_status(&self, text: &str) {
        let mut u = self.updates.borrow_mut();
        u.message = text.into();
        if let Some(label) = u.label.upgrade() {
            label.set_text(text);
        }
    }
    pub(super) fn check_update(&self, manual: bool) {
        if self.updates.borrow().busy {
            return;
        }
        self.updates.borrow_mut().busy = true;
        self.update_status("Проверяю обновления…");
        self.send(Command::CheckUpdate { manual });
    }
    pub(super) fn update_checked(
        &self,
        manual: bool,
        result: Result<Option<crate::update::Release>, String>,
    ) {
        self.updates.borrow_mut().busy = false;
        match result {
            Ok(Some(release)) => {
                self.update_status(&format!(
                    "Доступна версия {}. Можно скачать и установить ниже.",
                    release.version
                ));
                self.toast(&format!(
                    "Доступен Startrack {}. Настройки → Приложение → Обновления",
                    release.version
                ));
                self.updates.borrow_mut().pending = Some(release);
            }
            Ok(None) => self.update_status("Новых нативных обновлений пока нет."),
            Err(e) => {
                self.update_status(&format!("Не удалось проверить обновления: {e}"));
                if manual {
                    self.toast(&e);
                }
            }
        }
    }
    pub(super) fn update_progress(&self, done: u64, total: u64) {
        self.update_status(&format!(
            "Скачивание обновления: {:.1} / {:.1} МБ",
            done as f64 / 1048576.,
            total as f64 / 1048576.
        ));
    }
    pub(super) fn update_prepared(&self, result: Result<crate::update::Prepared, String>) {
        self.updates.borrow_mut().busy = false;
        match result {
            Ok(prepared) => {
                self.update_status(&format!(
                    "Версия {} готова. Подпись проверена. Нажмите «Установить» для перезапуска.",
                    prepared.version
                ));
                self.updates.borrow_mut().prepared = Some(prepared);
            }
            Err(e) => {
                self.update_status(&e);
                self.toast(&e);
            }
        }
    }
    pub(super) fn update_settings(self: &App) -> gtk::Box {
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
        box_.append(&label("Обновления", "heading"));
        let status = label(&self.updates.borrow().message, "muted");
        status.set_wrap(true);
        self.updates.borrow_mut().label = status.downgrade();
        box_.append(&status);
        let automatic = gtk::CheckButton::with_label("Проверять обновления автоматически");
        automatic.set_active(self.config.borrow().check_updates);
        box_.append(&automatic);
        let weak = Rc::downgrade(self);
        automatic.connect_toggled(move |b| {
            if let Some(a) = weak.upgrade() {
                a.config.borrow_mut().check_updates = b.is_active();
                let _ = a.config.borrow().save();
            }
        });
        let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let check = button("Проверить", "");
        let download = button("Скачать", "");
        let install = button("Установить", "");
        buttons.append(&check);
        buttons.append(&download);
        buttons.append(&install);
        box_.append(&buttons);
        let weak = Rc::downgrade(self);
        check.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.check_update(true);
            }
        });
        let weak = Rc::downgrade(self);
        download.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                if a.updates.borrow().busy {
                    return;
                }
                let release = a.updates.borrow().pending.clone();
                if let Some(release) = release {
                    a.updates.borrow_mut().busy = true;
                    a.update_status("Скачиваю обновление…");
                    a.send(Command::DownloadUpdate(release));
                } else {
                    a.check_update(true);
                }
            }
        });
        let weak = Rc::downgrade(self);
        install.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                if a.updates.borrow().busy { return; }
                if a.state.borrow().call.is_some() || a.state.borrow().joining || a.state.borrow().verity_busy {
                    a.toast("Завершите звонок и дождитесь ответа Верити перед обновлением."); return;
                }
                if a.updates.borrow().prepared.is_none() { a.toast("Сначала скачайте обновление."); return; }
                let weak = Rc::downgrade(&a);
                a.confirm("Установить обновление?", "Startrack завершится и запустится снова. Текущая версия сохранится в резервной папке.", move || {
                    if let Some(a) = weak.upgrade() {
                        if a.state.borrow().call.is_some() || a.state.borrow().joining || a.state.borrow().verity_busy { a.toast("Сначала завершите звонок и работу Верити."); return; }
                        let result = a.updates.borrow().prepared.as_ref().map(crate::update::install);
                        match result { Some(Ok(())) => a.quit(), Some(Err(e)) => a.toast(&format!("Обновление: {e:#}")), None => {} }
                    }
                });
            }
        });
        box_
    }
}
