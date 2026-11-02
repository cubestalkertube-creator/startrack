use super::*;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(super) struct Verity {
    pub(super) turn: String,
    chat: i64,
    calls: VecDeque<Value>,
    results: Vec<Value>,
    cancel: Arc<AtomicBool>,
    prompt: glib::WeakRef<gtk::MessageDialog>,
}
impl Client {
    pub(super) fn cancel_verity(&self) {
        let prompt = {
            let mut v = self.verity.borrow_mut();
            v.cancel.store(true, Ordering::Relaxed);
            let prompt = v.prompt.upgrade();
            *v = Verity::default();
            prompt
        };
        if let Some(prompt) = prompt {
            prompt.close();
        }
        self.state
            .borrow_mut()
            .pending_send
            .retain(|_, (conv, _)| !matches!(conv, Conversation::Verity(_)));
    }
    pub(super) fn verity_response(self: &App, chat: i64, data: &Value) {
        if let Some(calls) = data["pending"]["calls"].as_array() {
            let turn = data["pending"]["turn"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if turn.is_empty() || calls.len() > 16 {
                self.toast("Некорректный запрос инструментов Верити");
                return;
            }
            *self.verity.borrow_mut() = Verity {
                turn,
                chat,
                calls: calls.iter().cloned().collect(),
                ..Default::default()
            };
            self.state.borrow_mut().verity_busy = true;
            self.next_verity_tool();
        } else {
            self.state.borrow_mut().verity_busy = false;
            *self.verity.borrow_mut() = Verity::default();
        }
    }
    fn next_verity_tool(self: &App) {
        let (turn, chat, call, results, cancel) = {
            let v = self.verity.borrow();
            (
                v.turn.clone(),
                v.chat,
                v.calls.front().cloned(),
                v.results.clone(),
                v.cancel.clone(),
            )
        };
        if turn.is_empty() || cancel.load(Ordering::Relaxed) {
            return;
        }
        let Some(call) = call else {
            self.request(
                format!("verity-continue:{turn}"),
                "/api/verity/continue",
                Some(json!({"chat":chat,"turn":turn,"results":results})),
            );
            return;
        };
        let id = call["id"].as_str().unwrap_or_default().to_string();
        let name = call["name"].as_str().unwrap_or_default().to_string();
        let args = call["args"].clone();
        if self.config.borrow().verity_pc == "off" {
            self.verity_tool_done(turn, id, Err("Доступ к компьютеру выключен".into()));
            return;
        }
        let (description, risky) = match crate::verity::describe(&name, &args) {
            Ok(d) => d,
            Err(e) => {
                self.verity_tool_done(turn, id, Err(e));
                return;
            }
        };
        if !risky || self.config.borrow().verity_pc == "auto" {
            self.send(Command::VerityTool {
                turn,
                id,
                name,
                args,
                approved: risky,
                cancel,
            });
            return;
        }
        let dialog = gtk::MessageDialog::builder()
            .transient_for(&self.window)
            .modal(true)
            .message_type(gtk::MessageType::Question)
            .text("Верити просит разрешения")
            .secondary_text(&description)
            .build();
        dialog.add_button("Запретить", gtk::ResponseType::Cancel);
        dialog.add_button("Разрешить", gtk::ResponseType::Accept);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        self.verity.borrow_mut().prompt = dialog.downgrade();
        let weak = Rc::downgrade(self);
        dialog.connect_response(move |dialog, response| {
            dialog.close();
            if let Some(a) = weak.upgrade() {
                if a.verity.borrow().turn != turn || cancel.load(Ordering::Relaxed) {
                    return;
                }
                if response == gtk::ResponseType::Accept && a.config.borrow().verity_pc != "off" {
                    a.send(Command::VerityTool {
                        turn: turn.clone(),
                        id: id.clone(),
                        name: name.clone(),
                        args: args.clone(),
                        approved: true,
                        cancel: cancel.clone(),
                    });
                } else {
                    a.verity_tool_done(
                        turn.clone(),
                        id.clone(),
                        Err("Пользователь запретил действие".into()),
                    );
                }
            }
        });
        dialog.present();
    }
    pub(super) fn verity_tool_done(
        self: &App,
        turn: String,
        id: String,
        result: Result<String, String>,
    ) {
        {
            let mut v = self.verity.borrow_mut();
            if v.turn != turn
                || v.cancel.load(Ordering::Relaxed)
                || v.calls.front().and_then(|c| c["id"].as_str()) != Some(id.as_str())
            {
                return;
            }
            let (ok, out) = match result {
                Ok(out) => (true, out),
                Err(e) => (false, e),
            };
            v.results.push(json!({"id":id,"ok":ok,"out":out}));
            v.calls.pop_front();
        }
        self.next_verity_tool();
    }
    pub(super) fn stop_verity(self: &App) {
        let chat = self.verity.borrow().chat;
        let chat = if chat > 0 {
            chat
        } else {
            match self.state.borrow().selected {
                Some(Conversation::Verity(id)) => id,
                _ => 0,
            }
        };
        self.cancel_verity();
        self.state.borrow_mut().verity_busy = false;
        self.request(
            "verity-stop",
            "/api/verity/stop",
            if chat > 0 {
                Some(json!({"chat":chat}))
            } else {
                Some(json!({}))
            },
        );
        self.render_content();
    }
    pub(super) fn verity_settings(self: &App) -> gtk::Box {
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
        margins(&box_, 20);
        box_.append(&label("Доступ Верити к компьютеру", "heading"));
        let info = label("В режиме с подтверждением Верити сам работает в своей папке. Чтение и изменение других файлов, команды и запуск программ требуют вашего разрешения.", "muted");
        info.set_wrap(true);
        box_.append(&info);
        let workspace = label(
            &format!("Рабочая папка: {}", crate::verity::workspace().display()),
            "",
        );
        workspace.set_wrap(true);
        workspace.set_selectable(true);
        box_.append(&workspace);
        let choice =
            gtk::DropDown::from_strings(&["Выключен", "С подтверждением", "Без подтверждений"]);
        choice.set_selected(match self.config.borrow().verity_pc.as_str() {
            "off" => 0,
            "auto" => 2,
            _ => 1,
        });
        box_.append(&choice);
        let weak = Rc::downgrade(self);
        choice.connect_selected_notify(move |d| {
            let Some(a) = weak.upgrade() else { return; };
            let mode = match d.selected() { 0 => "off", 2 => "auto", _ => "ask" };
            if a.config.borrow().verity_pc == mode { return; }
            if mode == "auto" {
                // Return to the old selection until the native confirmation is accepted.
                d.set_selected(if a.config.borrow().verity_pc == "off" { 0 } else { 1 });
                let w = Rc::downgrade(&a); let dropdown = d.downgrade();
                a.confirm("Верити: полный доступ", "Разрешить Верити выполнять команды, запускать программы и менять файлы без отдельных подтверждений? Выключить доступ можно в настройках.", move || {
                    if let Some(a) = w.upgrade() {
                        a.config.borrow_mut().verity_pc = "auto".into(); let _ = a.config.borrow().save();
                        if let Some(d) = dropdown.upgrade() { d.set_selected(2); }
                    }
                });
            } else {
                a.cancel_verity(); a.state.borrow_mut().verity_busy = false;
                a.config.borrow_mut().verity_pc = mode.into(); let _ = a.config.borrow().save();
            }
        });
        box_
    }
}
