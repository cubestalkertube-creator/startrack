mod activity;
mod assets;
mod crop;
mod menus;
mod playback;
mod settings;
mod sounds;
mod updates;
mod verity;

use crate::{
    config::Config,
    media,
    model::*,
    worker::{self, Command, Event},
};
use gtk::{gdk, gio, glib, prelude::*};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    rc::Rc,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

pub type App = Rc<Client>;
pub struct Client {
    pub window: gtk::ApplicationWindow,
    pub config: RefCell<Config>,
    pub state: RefCell<State>,
    pub tx: tokio::sync::mpsc::UnboundedSender<Command>,
    pub root: gtk::Box,
    pub sidebar: gtk::Box,
    pub conversations: gtk::Box,
    pub header: gtk::Box,
    pub timeline: gtk::Box,
    pub scroll: gtk::ScrolledWindow,
    pub composer: gtk::TextView,
    pub compose_box: gtk::Box,
    pub notice: gtk::Label,
    pub call_box: gtk::Box,
    pub videos: gtk::Box,
    pub frames: media::Frames,
    pub pictures: RefCell<BTreeMap<String, gtk::Picture>>,
    assets: RefCell<assets::Assets>,
    audio: crate::audio::Output,
    sounds: RefCell<sounds::Sounds>,
    tray: RefCell<Option<crate::desktop::Tray>>,
    verity: RefCell<verity::Verity>,
    updates: RefCell<updates::Updates>,
}
pub struct State {
    pub session: Option<Session>,
    pub api: Option<worker::ApiInfo>,
    pub selected: Option<Conversation>,
    pub tab: String,
    pub filter: String,
    pub connected: bool,
    pub registering: bool,
    pub auth_busy: bool,
    pub call: Option<Conversation>,
    pub joining: bool,
    pub muted: bool,
    pub user_mutes: BTreeMap<String, bool>,
    pub deaf: bool,
    pub sharing: bool,
    pub ringing: bool,
    pub incoming: Option<(Conversation, gtk::Window)>,
    pub participants: Vec<(String, String, bool)>,
    pub draft: BTreeMap<Conversation, String>,
    pub loading: Vec<Conversation>,
    pub pending_send: BTreeMap<String, (Conversation, String)>,
    pub next_request: u64,
    pub verity_chats: Vec<Value>,
    pub verity_messages: BTreeMap<i64, Vec<Value>>,
    pub verity_busy: bool,
    pub last_activity: Instant,
    pub idle: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            session: None,
            api: None,
            selected: None,
            tab: "online".into(),
            filter: String::new(),
            connected: false,
            registering: false,
            auth_busy: false,
            call: None,
            joining: false,
            muted: false,
            user_mutes: BTreeMap::new(),
            deaf: false,
            sharing: false,
            ringing: false,
            incoming: None,
            participants: vec![],
            draft: BTreeMap::new(),
            loading: vec![],
            pending_send: BTreeMap::new(),
            next_request: 0,
            verity_chats: vec![],
            verity_messages: BTreeMap::new(),
            verity_busy: false,
            last_activity: Instant::now(),
            idle: false,
        }
    }
}

pub fn launch(application: &gtk::Application) {
    if let Some(window) = application
        .active_window()
        .or_else(|| application.windows().into_iter().next())
    {
        window.present();
        return;
    }
    let app = build_client(application);
    // Desktop integration runs only for a real application, never for hidden widget tests.
    match crate::desktop::Tray::new() {
        Ok(tray) => *app.tray.borrow_mut() = Some(tray),
        Err(e) => eprintln!("Трей недоступен: {e}"),
    }
    if app.config.borrow().autostart {
        if let Err(e) = crate::desktop::set_autostart(true) {
            eprintln!("Автозапуск: {e}");
        }
    }
    let weak = Rc::downgrade(&app);
    glib::timeout_add_local_once(Duration::from_secs(5), move || {
        if let Some(a) = weak.upgrade() {
            if a.config.borrow().check_updates {
                a.check_update(false);
            }
        }
    });
    let weak = Rc::downgrade(&app);
    glib::timeout_add_local(Duration::from_secs(6 * 60 * 60), move || {
        let Some(a) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        if a.config.borrow().check_updates {
            a.check_update(false);
        }
        glib::ControlFlow::Continue
    });
    app.auth("");
    if !cfg!(debug_assertions) || std::env::var("STARTRACK_DEMO").as_deref() != Ok("1") {
        let config = app.config.borrow();
        if !config.username.is_empty() {
            app.send(Command::Resume {
                server: config.server.clone(),
                username: config.username.clone(),
            });
        }
    }
    #[cfg(debug_assertions)]
    if std::env::var("STARTRACK_DEMO").as_deref() == Ok("1") {
        let me = User {
            id: 1,
            username: "demo".into(),
            display: "Вы".into(),
            online: true,
            ..Default::default()
        };
        let friend = User {
            id: 2,
            username: "nova".into(),
            display: "Нова".into(),
            online: true,
            bio: "Тестовый профиль нативного клиента".into(),
            ..Default::default()
        };
        let mut session = Session {
            me,
            friends: Friends {
                friends: vec![friend.clone()],
                ..Default::default()
            },
            groups: vec![Group {
                id: 3,
                name: "Команда Startrack".into(),
                owner: 1,
                members: vec![friend],
                ..Default::default()
            }],
            ..Default::default()
        };
        session.messages.insert(
            Conversation::User(2),
            vec![
                Message {
                    id: 1,
                    sender: 2,
                    recipient: 1,
                    text:
                        "Привет! Это нативный интерфейс GTK 4. Нажмите правой кнопкой по сообщению."
                            .into(),
                    created: chrono::Utc::now().timestamp_millis(),
                    ..Default::default()
                },
                Message {
                    id: 2,
                    sender: 1,
                    recipient: 2,
                    text: "Меню работает и с клавиатуры: Shift+F10.".into(),
                    created: chrono::Utc::now().timestamp_millis(),
                    ..Default::default()
                },
            ],
        );
        app.state.borrow_mut().session = Some(session);
        app.state.borrow_mut().connected = true;
        app.state.borrow_mut().selected = Some(Conversation::User(2));
        app.shell();
    }
    if !std::env::args().any(|arg| arg == "--autostart") || app.tray.borrow().is_none() {
        app.window.present();
    }
    #[cfg(debug_assertions)]
    if std::env::var("STARTRACK_DEMO").as_deref() == Ok("1") {
        match std::env::var("STARTRACK_DEMO_PANEL").as_deref() {
            Ok("settings") => app.settings(),
            Ok(kind @ ("avatar" | "banner")) => {
                let bytes = include_bytes!("../assets/nova_helper.png").to_vec();
                if let Ok(preview) = crate::images::decode(bytes) {
                    app.crop_image(kind.into(), std::path::PathBuf::from("demo.png"), preview);
                }
            }
            _ => {}
        }
    }
    // Keep the controller alive for the lifetime of the native window.
    app.window.connect_destroy({
        let app = app.clone();
        move |_| {
            app.send(Command::Shutdown);
            app.audio.stop_all();
        }
    });
}

fn build_client(application: &gtk::Application) -> App {
    let css = gtk::CssProvider::new();
    css.load_from_data(include_str!("../native.css"));
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("display"),
        &css,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    let window = gtk::ApplicationWindow::builder()
        .application(application)
        .title("Startrack")
        .default_width(1200)
        .default_height(780)
        .build();
    let title = gtk::HeaderBar::new();
    let name = label("✦  Startrack", "heading");
    title.set_title_widget(Some(&name));
    window.set_titlebar(Some(&title));
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.set_child(Some(&root));
    let sidebar = gtk::Box::new(gtk::Orientation::Vertical, 7);
    sidebar.add_css_class("sidebar");
    sidebar.set_width_request(250);
    sidebar.set_hexpand(false);
    let conversations = gtk::Box::new(gtk::Orientation::Vertical, 3);
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    header.add_css_class("chat-header");
    let timeline = gtk::Box::new(gtk::Orientation::Vertical, 2);
    timeline.set_valign(gtk::Align::Start);
    let scroll = gtk::ScrolledWindow::builder()
        .vexpand(true)
        .hexpand(true)
        .child(&timeline)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .build();
    let composer = gtk::TextView::builder()
        .wrap_mode(gtk::WrapMode::WordChar)
        .height_request(52)
        .vexpand(false)
        .hexpand(true)
        .accepts_tab(false)
        .build();
    let compose_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    compose_box.add_css_class("composer");
    let notice = label("", "muted");
    notice.set_wrap(true);
    notice.set_xalign(0.);
    notice.set_margin_start(14);
    notice.set_margin_end(14);
    notice.set_visible(false);
    let call_box = gtk::Box::new(gtk::Orientation::Vertical, 8);
    call_box.add_css_class("call-panel");
    call_box.set_visible(false);
    let videos = gtk::Box::new(gtk::Orientation::Vertical, 8);
    let frames = Arc::new(Mutex::new(BTreeMap::new()));
    let (events, rx) = mpsc::channel();
    let audio = crate::audio::Output::start(events.clone());
    let tx = worker::start(events, frames.clone());
    let app = Rc::new(Client {
        window,
        config: RefCell::new(Config::load()),
        state: RefCell::new(State::default()),
        tx,
        root,
        sidebar,
        conversations,
        header,
        timeline,
        scroll,
        composer,
        compose_box,
        notice,
        call_box,
        videos,
        frames,
        pictures: RefCell::new(BTreeMap::new()),
        assets: RefCell::new(assets::Assets::default()),
        audio,
        sounds: RefCell::new(sounds::Sounds::default()),
        tray: RefCell::new(None),
        verity: RefCell::new(verity::Verity::default()),
        updates: RefCell::new(updates::Updates::default()),
    });
    app.audio.configure(&app.config.borrow());
    if app.config.borrow().theme == "light" {
        app.window.add_css_class("light");
    }
    let open_chat = gio::SimpleAction::new("chat", Some(&String::static_variant_type()));
    let weak = Rc::downgrade(&app);
    open_chat.connect_activate(move |_, value| {
        if let (Some(a), Some(key)) = (weak.upgrade(), value.and_then(|v| v.get::<String>())) {
            if a.state.borrow().session.is_some() {
                a.select(parse_conv(&key));
                a.window.present();
            }
        }
    });
    application.add_action(&open_chat);
    let drop = gtk::DropTarget::new(gio::File::static_type(), gdk::DragAction::COPY);
    let weak = Rc::downgrade(&app);
    drop.connect_drop(move |_, value, _, _| {
        if let (Some(a), Ok(file)) = (weak.upgrade(), value.get::<gio::File>()) {
            if let (Some(conv), Some(file)) = (a.state.borrow().selected, file.path()) {
                a.send(Command::Upload { conv, file });
                return true;
            }
        }
        false
    });
    app.timeline.add_controller(drop);
    let weak = Rc::downgrade(&app);
    glib::timeout_add_local(Duration::from_millis(33), move || {
        let Some(app) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        for _ in 0..200 {
            match rx.try_recv() {
                Ok(event) => app.event(event),
                Err(_) => break,
            }
        }
        app.draw_frames();
        app.assets
            .borrow_mut()
            .animate(app.config.borrow().animate_gifs);
        app.sync_ringing();
        let action = app.tray.borrow().as_ref().and_then(|tray| tray.poll());
        match action {
            Some(crate::desktop::Action::Show) => app.window.present(),
            Some(crate::desktop::Action::Quit) => {
                app.quit();
                return glib::ControlFlow::Break;
            }
            None => {}
        }
        let idle = app.state.borrow().last_activity.elapsed() > Duration::from_secs(600);
        if idle != app.state.borrow().idle {
            app.state.borrow_mut().idle = idle;
            app.socket(json!({"type":"afk","afk":idle}));
        }
        glib::ControlFlow::Continue
    });
    let key = gtk::EventControllerKey::new();
    let weak = Rc::downgrade(&app);
    key.connect_key_pressed(move |_, key, _, mods| {
        if let Some(app) = weak.upgrade() {
            app.state.borrow_mut().last_activity = Instant::now();
            if key == gdk::Key::Return && !mods.contains(gdk::ModifierType::SHIFT_MASK) {
                app.send_message();
                return glib::Propagation::Stop;
            }
        }
        glib::Propagation::Proceed
    });
    app.composer.add_controller(key);
    let motion = gtk::EventControllerMotion::new();
    let weak = Rc::downgrade(&app);
    motion.connect_motion(move |_, _, _| {
        if let Some(a) = weak.upgrade() {
            a.state.borrow_mut().last_activity = Instant::now();
        }
    });
    app.window.add_controller(motion);
    let activity = gtk::EventControllerKey::new();
    let weak = Rc::downgrade(&app);
    activity.connect_key_pressed(move |_, _, _, _| {
        if let Some(a) = weak.upgrade() {
            a.state.borrow_mut().last_activity = Instant::now();
        }
        glib::Propagation::Proceed
    });
    app.window.add_controller(activity);
    let weak = Rc::downgrade(&app);
    app.window.connect_close_request(move |_| {
        if let Some(a) = weak.upgrade() {
            if a.config.borrow().close_to_tray && a.tray.borrow().is_some() {
                a.window.set_visible(false);
                return glib::Propagation::Stop;
            }
            a.send(Command::Shutdown);
            a.cancel_verity();
            a.audio.stop_all();
        }
        glib::Propagation::Proceed
    });
    app
}

impl Client {
    pub fn quit(&self) {
        self.cancel_verity();
        self.send(Command::Shutdown);
        self.audio.stop_all();
        self.tray.borrow_mut().take();
        if let Some(application) = self.window.application() {
            application.quit();
        }
    }
    pub fn send(&self, command: Command) {
        let _ = self.tx.send(command);
    }
    pub fn request(&self, tag: impl Into<String>, path: impl Into<String>, body: Option<Value>) {
        self.send(Command::Request {
            tag: tag.into(),
            path: path.into(),
            body,
        });
    }
    pub fn socket(&self, data: Value) {
        if !self.state.borrow().connected {
            return;
        }
        self.send(Command::Socket(data));
    }
    pub fn media(&self, command: media::Command) {
        self.send(Command::Media(command));
    }
    pub fn toast(&self, text: &str) {
        self.notice.set_label(text);
        self.notice.set_visible(!text.is_empty());
    }
    pub fn refresh(&self) {
        self.request("friends", "/api/friends", None);
        self.request("groups", "/api/groups", None);
    }
    fn auth(self: &App, error: &str) {
        clear(&self.root);
        let bg = gtk::Box::new(gtk::Orientation::Vertical, 0);
        bg.set_vexpand(true);
        bg.set_hexpand(true);
        bg.set_halign(gtk::Align::Center);
        bg.set_valign(gtk::Align::Center);
        let card = gtk::Box::new(gtk::Orientation::Vertical, 14);
        card.add_css_class("auth-card");
        card.set_width_request(400);
        card.append(&label("✦  Startrack", "title"));
        let registering = self.state.borrow().registering;
        card.append(&label(
            if registering {
                "Создать учётную запись"
            } else {
                "С возвращением!"
            },
            "heading",
        ));
        card.append(&label(
            "Друзья, сообщения и звонки — в одном месте.",
            "muted",
        ));
        let username = gtk::Entry::builder()
            .placeholder_text("Ник")
            .text(&self.config.borrow().username)
            .max_length(32)
            .build();
        let password = gtk::PasswordEntry::builder()
            .placeholder_text("Пароль")
            .show_peek_icon(true)
            .build();
        let repeat = gtk::PasswordEntry::builder()
            .placeholder_text("Повторите пароль")
            .show_peek_icon(true)
            .visible(registering)
            .build();
        card.append(&username);
        card.append(&password);
        card.append(&repeat);
        let server = gtk::Entry::builder()
            .text(&self.config.borrow().server)
            .placeholder_text("https://сервер")
            .build();
        let connection = gtk::Expander::builder()
            .label("Подключение к серверу")
            .child(&server)
            .build();
        card.append(&connection);
        let err = label(error, "error");
        err.set_wrap(true);
        card.append(&err);
        let login = button(
            if registering {
                "Зарегистрироваться"
            } else {
                "Войти"
            },
            "suggested-action",
        );
        card.append(&login);
        let switch = button(
            if registering {
                "Уже есть аккаунт? Войти"
            } else {
                "Создать аккаунт"
            },
            "",
        );
        card.append(&switch);
        card.append(&label(
            &format!("{} · Rust + GTK 4", env!("CARGO_PKG_VERSION")),
            "muted",
        ));
        bg.append(&card);
        self.root.append(&bg);
        let weak = Rc::downgrade(self);
        switch.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                let reg = a.state.borrow().registering;
                a.state.borrow_mut().registering = !reg;
                a.auth("");
            }
        });
        let weak = Rc::downgrade(self);
        let login_clone = login.clone();
        let submit = Rc::new(move || {
            let Some(a) = weak.upgrade() else { return };
            if a.state.borrow().auth_busy {
                return;
            }
            let u = username.text().trim().to_string();
            let p = password.text().to_string();
            if u.is_empty() || p.is_empty() {
                err.set_label("Введите ник и пароль");
                return;
            }
            if registering && (p.chars().count() < 6 || p != repeat.text().as_str()) {
                err.set_label("Пароль должен быть от 6 символов, и оба пароля должны совпадать");
                return;
            }
            let s = server.text().trim().to_string();
            if let Err(e) = crate::api::Api::new(&s, String::new()) {
                err.set_label(&e.to_string());
                return;
            }
            a.state.borrow_mut().auth_busy = true;
            login_clone.set_sensitive(false);
            login_clone.set_label("Подключение…");
            a.config.borrow_mut().username = u.clone();
            a.config.borrow_mut().server = s.clone();
            a.send(Command::Login {
                server: s,
                username: u,
                password: p,
                register: registering,
            });
        });
        let go = submit.clone();
        login.connect_clicked(move |_| go());
        // PasswordEntry does not emit Entry::activate; Enter is handled locally.
        let key = gtk::EventControllerKey::new();
        key.connect_key_pressed(move |_, key, _, _| {
            if key == gdk::Key::Return {
                submit();
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        card.add_controller(key);
    }
    fn shell(self: &App) {
        clear(&self.root);
        self.root.append(&self.notice);
        let body = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        body.set_vexpand(true);
        body.append(&self.sidebar);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        content.set_hexpand(true);
        content.append(&self.header);
        content.append(&self.call_box);
        content.append(&self.videos);
        content.append(&self.scroll);
        content.append(&self.compose_box);
        body.append(&content);
        self.root.append(&body);
        clear(&self.compose_box);
        let attach = button("＋", "");
        attach.set_tooltip_text(Some("Прикрепить файл"));
        self.compose_box.append(&attach);
        self.compose_box.append(&self.composer);
        let emoji = button("☺", "");
        self.compose_box.append(&emoji);
        let gifs = button("GIF", "");
        self.compose_box.append(&gifs);
        let send = button("Отправить", "suggested-action");
        self.compose_box.append(&send);
        let weak = Rc::downgrade(self);
        attach.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.pick_upload();
            }
        });
        let weak = Rc::downgrade(self);
        send.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.send_message();
            }
        });
        let weak = Rc::downgrade(self);
        emoji.connect_clicked(move |b| {
            if let Some(a) = weak.upgrade() {
                a.emoji_picker(b);
            }
        });
        let weak = Rc::downgrade(self);
        gifs.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.request("gifs", "/api/gifs", None);
            }
        });

        self.render_sidebar();
        self.render_content();
    }
    pub fn render_sidebar(self: &App) {
        clear(&self.sidebar);
        let search = gtk::SearchEntry::builder()
            .placeholder_text("Найти беседу")
            .text(&self.state.borrow().filter)
            .build();
        self.sidebar.append(&search);
        let weak = Rc::downgrade(self);
        search.connect_search_changed(move |e| {
            if let Some(a) = weak.upgrade() {
                a.state.borrow_mut().filter = e.text().to_lowercase();
                a.render_conversations();
            }
        });
        let home = button("♟  Друзья", "");
        self.sidebar.append(&home);
        let weak = Rc::downgrade(self);
        home.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.select(None);
            }
        });
        let top = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let title = label("ЛИЧНЫЕ СООБЩЕНИЯ", "muted");
        title.set_hexpand(true);
        title.set_xalign(0.);
        top.append(&title);
        let plus = button("＋", "");
        top.append(&plus);
        self.sidebar.append(&top);
        let weak = Rc::downgrade(self);
        plus.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.group_dialog(None);
            }
        });
        let conversations = self.conversations.clone();
        let scroll = gtk::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .child(&conversations)
            .build();
        self.sidebar.append(&scroll);
        self.render_conversations();
        let userbar = gtk::Box::new(gtk::Orientation::Vertical, 7);
        userbar.add_css_class("userbar");
        let (name, status) = self
            .state
            .borrow()
            .session
            .as_ref()
            .map(|s| {
                (
                    s.me.name().to_string(),
                    if self.state.borrow().connected {
                        s.me.status_label().to_string()
                    } else {
                        "Подключение…".into()
                    },
                )
            })
            .unwrap_or_default();
        let me = button(&format!("{name}\n{status}"), "");
        userbar.append(&me);
        if let Some(user) = self.state.borrow().session.as_ref().map(|s| s.me.clone()) {
            userbar.append(&self.activity_label(user, false));
        }
        let weak = Rc::downgrade(self);
        me.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.self_menu();
            }
        });
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let mute = button(
            if self.state.borrow().muted {
                "Микр. выкл."
            } else {
                "Микрофон"
            },
            "",
        );
        let deaf = button(
            if self.state.borrow().deaf {
                "Звук выкл."
            } else {
                "Звук"
            },
            "",
        );
        let settings = button("⚙", "");
        row.append(&mute);
        row.append(&deaf);
        row.append(&settings);
        userbar.append(&row);
        self.sidebar.append(&userbar);
        let weak = Rc::downgrade(self);
        mute.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                let muted = !a.state.borrow().muted;
                a.state.borrow_mut().muted = muted;
                a.media(media::Command::Mute(muted));
                a.cue(if muted {
                    crate::audio::Cue::Mute
                } else {
                    crate::audio::Cue::Unmute
                });
                a.render_sidebar();
            }
        });
        let weak = Rc::downgrade(self);
        deaf.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                let deaf = !a.state.borrow().deaf;
                a.state.borrow_mut().deaf = deaf;
                a.media(media::Command::Deaf(deaf));
                if deaf {
                    a.stop_board();
                }
                a.cue(if deaf {
                    crate::audio::Cue::Deafen
                } else {
                    crate::audio::Cue::Undeafen
                });
                a.render_sidebar();
            }
        });
        let weak = Rc::downgrade(self);
        settings.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.settings();
            }
        });
    }
    fn render_conversations(self: &App) {
        let list = self.conversations.clone();
        clear(&list);
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        let mut items = vec![(
            Conversation::Verity(0),
            "☺  Верити".to_string(),
            "Ваш AI-помощник".to_string(),
        )];
        items.extend(session.groups.iter().map(|g| {
            (
                Conversation::Group(g.id),
                format!("♟  {}", g.title()),
                format!("{} участников", g.members.len()),
            )
        }));
        items.extend(session.friends.friends.iter().map(|u| {
            (
                Conversation::User(u.id),
                u.name().to_string(),
                u.visible_game(session.me.id)
                    .map(|g| format!("Играет в {}", g.name))
                    .unwrap_or_else(|| u.status_label().to_string()),
            )
        }));
        for (conv, title, sub) in items {
            if !state.filter.is_empty() && !title.to_lowercase().contains(&state.filter) {
                continue;
            }
            let unread = session.unread.get(&conv).copied().unwrap_or_default();
            let row = button(
                &format!(
                    "{title}{}\n{sub}",
                    if unread > 0 {
                        format!("  ({unread})")
                    } else {
                        String::new()
                    }
                ),
                "conversation",
            );
            if state.selected == Some(conv) {
                row.add_css_class("selected");
            }
            row.set_halign(gtk::Align::Fill);
            if let Some(l) = row.child().and_then(|w| w.downcast::<gtk::Label>().ok()) {
                l.set_ellipsize(gtk::pango::EllipsizeMode::End);
                l.set_max_width_chars(24);
                l.set_xalign(0.);
            }
            let weak = Rc::downgrade(self);
            row.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.select(Some(conv));
                }
            });
            self.conversation_menu(&row, conv);
            list.append(&row);
        }
    }
    pub fn select(self: &App, conv: Option<Conversation>) {
        let old = self.state.borrow().selected;
        if let Some(old) = old {
            let b = self.composer.buffer();
            let draft = b.text(&b.start_iter(), &b.end_iter(), true).to_string();
            self.state.borrow_mut().draft.insert(old, draft);
        }
        self.state.borrow_mut().selected = conv;
        if let Some(conv) = conv {
            let draft = self
                .state
                .borrow()
                .draft
                .get(&conv)
                .cloned()
                .unwrap_or_default();
            self.composer.buffer().set_text(&draft);
            if let Some(s) = self.state.borrow_mut().session.as_mut() {
                s.unread.remove(&conv);
            }
            match conv {
                Conversation::Verity(id) => self.request(
                    format!("verity:{id}"),
                    if id == 0 {
                        "/api/verity".into()
                    } else {
                        conv.history_path()
                    },
                    None,
                ),
                _ => {
                    let need = self
                        .state
                        .borrow()
                        .session
                        .as_ref()
                        .is_some_and(|s| !s.messages.contains_key(&conv));
                    if need && !self.state.borrow().loading.contains(&conv) {
                        self.state.borrow_mut().loading.push(conv);
                        self.request(format!("history:{}", conv.key()), conv.history_path(), None);
                    }
                }
            }
        }
        self.render_conversations();
        self.render_content();
        self.composer.grab_focus();
    }
    pub fn render_content(self: &App) {
        let adjustment = self.scroll.vadjustment();
        let old_scroll = adjustment.value();
        let stick = adjustment.upper() - adjustment.value() - adjustment.page_size() < 80.;
        clear(&self.header);
        clear(&self.timeline);
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        self.compose_box.set_visible(state.selected.is_some());
        let Some(conv) = state.selected else {
            drop(state);
            self.render_friends();
            return;
        };
        let heading = label(&session.title(conv), "heading");
        heading.set_hexpand(true);
        heading.set_xalign(0.);
        self.header.append(&heading);
        let profile = button("Профиль", "");
        self.header.append(&profile);
        let weak = Rc::downgrade(self);
        profile.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                match conv {
                    Conversation::User(id) => a.request(
                        format!("profile:{id}"),
                        format!("/api/users/profile?id={id}"),
                        None,
                    ),
                    Conversation::Group(_) => a.group_members(conv),
                    Conversation::Verity(_) => a.verity_chats(),
                }
            }
        });
        if !matches!(conv, Conversation::Verity(_)) {
            let call = button("Позвонить", "suggested-action");
            self.header.append(&call);
            let weak = Rc::downgrade(self);
            call.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.call(conv, false);
                }
            });
        } else {
            let new = button("Новый чат", "");
            self.header.append(&new);
            let weak = Rc::downgrade(self);
            new.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.state.borrow_mut().verity_messages.insert(0, vec![]);
                    a.select(Some(Conversation::Verity(0)));
                }
            });
        }
        match conv {
            Conversation::Verity(id) => {
                if let Some(list) = state.verity_messages.get(&id) {
                    for m in list {
                        let row = gtk::Box::new(gtk::Orientation::Vertical, 4);
                        row.add_css_class("message");
                        row.append(&label(
                            if m["role"] == "user" {
                                session.me.name()
                            } else {
                                "Верити"
                            },
                            "heading",
                        ));
                        let text = label(m["text"].as_str().unwrap_or_default(), "");
                        text.set_wrap(true);
                        text.set_selectable(true);
                        text.set_xalign(0.);
                        row.append(&text);
                        self.timeline.append(&row);
                    }
                }
                if state.verity_busy {
                    self.timeline.append(&label("Верити отвечает…", "muted"));
                    let stop = button("Остановить", "");
                    self.timeline.append(&stop);
                    let weak = Rc::downgrade(self);
                    stop.connect_clicked(move |_| {
                        if let Some(a) = weak.upgrade() {
                            a.stop_verity();
                        }
                    });
                }
            }
            _ => {
                let intro = gtk::Box::new(gtk::Orientation::Vertical, 8);
                margins(&intro, 24);
                intro.append(&label(&session.title(conv), "title"));
                intro.append(&label("Начало вашей переписки", "muted"));
                self.timeline.append(&intro);
                if state.loading.contains(&conv) {
                    self.timeline.append(&label("Загрузка сообщений…", "muted"));
                }
                if let Some(messages) = session.messages.get(&conv) {
                    for message in messages {
                        self.message_row(session, message);
                    }
                }
                if let Some(messages) = session.messages.get(&conv).filter(|m| m.len() >= 50) {
                    if let Some(first) = messages.first() {
                        let more = button("Загрузить предыдущие сообщения", "");
                        let before = first.id;
                        let weak = Rc::downgrade(self);
                        more.connect_clicked(move |_| {
                            if let Some(a) = weak.upgrade() {
                                a.request(
                                    format!("history:{}", conv.key()),
                                    format!("{}&before={before}", conv.history_path()),
                                    None,
                                );
                            }
                        });
                        self.timeline.prepend(&more);
                    }
                }
            }
        }
        drop(state);
        let scroll = self.scroll.clone();
        glib::idle_add_local_once(move || {
            let a = scroll.vadjustment();
            a.set_value(if stick {
                (a.upper() - a.page_size()).max(0.)
            } else {
                old_scroll
            });
        });
    }
    fn message_row(self: &App, session: &Session, message: &Message) {
        let row = gtk::Box::new(gtk::Orientation::Vertical, 4);
        row.add_css_class("message");
        let author = session
            .user(message.sender)
            .map(User::name)
            .or(message.sname.as_deref())
            .unwrap_or("Пользователь");
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.append(&label(author, "heading"));
        let stamp = chrono::DateTime::from_timestamp_millis(message.created)
            .map(|t| {
                t.with_timezone(&chrono::Local)
                    .format("%d.%m.%Y %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        header.append(&label(&stamp, "muted"));
        row.append(&header);
        let text = label(
            &message.text,
            if message.kind.is_some() { "muted" } else { "" },
        );
        text.set_wrap(true);
        text.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        text.set_xalign(0.);
        text.set_selectable(true);
        row.append(&text);
        if let Some(file) = &message.file {
            if file.mime.starts_with("image/") {
                row.append(&self.image(&format!("/api/files/{}", file.id), 320, 200));
            }
            let file_button = button(&format!("⇩  {} · {}", file.name, filesize(file.size)), "");
            row.append(&file_button);
            let weak = Rc::downgrade(self);
            let file = file.clone();
            file_button.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.save_file(&file);
                }
            });
        }
        self.message_menu(&row, message, session.me.id);
        self.timeline.append(&row);
    }
    fn render_friends(self: &App) {
        let state = self.state.borrow();
        let Some(session) = &state.session else {
            return;
        };
        for (key, title) in [
            ("online", "В сети"),
            ("all", "Все"),
            ("pending", "Ожидание"),
            ("add", "Добавить друга"),
        ] {
            let b = button(
                title,
                if state.tab == key {
                    "suggested-action"
                } else {
                    ""
                },
            );
            self.header.append(&b);
            let weak = Rc::downgrade(self);
            b.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.state.borrow_mut().tab = key.into();
                    a.render_content();
                }
            });
        }
        if state.tab == "add" {
            let box_ = gtk::Box::new(gtk::Orientation::Vertical, 12);
            margins(&box_, 28);
            box_.append(&label("Добавить в друзья", "title"));
            let entry = gtk::Entry::builder().placeholder_text("Ник друга").build();
            box_.append(&entry);
            let add = button("Отправить запрос", "suggested-action");
            box_.append(&add);
            let weak = Rc::downgrade(self);
            add.connect_clicked(move |_| {
                if let Some(a) = weak.upgrade() {
                    a.request(
                        "friends",
                        "/api/friends/request",
                        Some(json!({"username":entry.text().trim()})),
                    );
                }
            });
            self.timeline.append(&box_);
            return;
        }
        let pending = state.tab == "pending";
        let list: Vec<_> = if pending {
            session
                .friends
                .incoming
                .iter()
                .map(|u| (u, true))
                .chain(session.friends.outgoing.iter().map(|u| (u, false)))
                .collect()
        } else {
            session
                .friends
                .friends
                .iter()
                .filter(|u| state.tab != "online" || u.online)
                .map(|u| (u, false))
                .collect()
        };
        if list.is_empty() {
            let box_ = gtk::Box::new(gtk::Orientation::Vertical, 16);
            margins(&box_, 40);
            let image = gtk::Picture::new();
            if let Ok(texture) = gdk::Texture::from_bytes(&glib::Bytes::from_static(
                include_bytes!("../assets/nova_sleep.png"),
            )) {
                image.set_paintable(Some(&texture));
            }
            image.set_size_request(190, 190);
            image.set_can_shrink(true);
            box_.append(&image);
            box_.append(&label(
                if pending {
                    "Запросов дружбы пока нет"
                } else {
                    "Сейчас здесь тихо"
                },
                "title",
            ));
            box_.append(&label(
                "Добавьте друзей по нику и начните общение.",
                "muted",
            ));
            self.timeline.append(&box_);
        }
        for (u, incoming) in list {
            let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            row.add_css_class("message");
            let name = label(&format!("{}  @{}", u.name(), u.username), "heading");
            name.set_xalign(0.);
            name.set_hexpand(true);
            row.append(&name);
            row.append(&label(u.status_label(), "muted"));
            row.append(&self.activity_label(u.clone(), false));
            let id = u.id;
            if pending {
                if incoming {
                    let accept = button("Принять", "suggested-action");
                    row.append(&accept);
                    let weak = Rc::downgrade(self);
                    accept.connect_clicked(move |_| {
                        if let Some(a) = weak.upgrade() {
                            a.request("friends", "/api/friends/accept", Some(json!({"userId":id})));
                        }
                    });
                }
                let reject = button("Отменить", "");
                row.append(&reject);
                let weak = Rc::downgrade(self);
                reject.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        a.request("friends", "/api/friends/remove", Some(json!({"userId":id})));
                    }
                });
            } else {
                let dm = button("Написать", "");
                row.append(&dm);
                let weak = Rc::downgrade(self);
                dm.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        a.select(Some(Conversation::User(id)));
                    }
                });
                let call = button("Позвонить", "");
                row.append(&call);
                let weak = Rc::downgrade(self);
                call.connect_clicked(move |_| {
                    if let Some(a) = weak.upgrade() {
                        a.call(Conversation::User(id), false);
                    }
                });
            }
            self.user_menu(&row, id);
            self.timeline.append(&row);
        }
    }
    fn send_message(self: &App) {
        let buffer = self.composer.buffer();
        let text = buffer
            .text(&buffer.start_iter(), &buffer.end_iter(), true)
            .trim()
            .to_string();
        let Some(conv) = self.state.borrow().selected else {
            return;
        };
        if text.is_empty() {
            return;
        }
        if text.chars().count() > 4000 {
            self.toast("Сообщение не должно быть длиннее 4000 символов");
            return;
        }
        if matches!(conv, Conversation::Verity(_)) && self.state.borrow().verity_busy {
            return;
        }
        let mut body = conv.target();
        body["text"] = json!(replace_emoji_codes(&text));
        let tag = {
            let mut state = self.state.borrow_mut();
            state.next_request += 1;
            let tag = format!("send:{}", state.next_request);
            state.pending_send.insert(tag.clone(), (conv, text.clone()));
            tag
        };
        if let Conversation::Verity(id) = conv {
            body["pc"] = json!(self.config.borrow().verity_pc != "off");
            body["ctx"] = json!({"ws":crate::verity::workspace().to_string_lossy(),"os":std::env::consts::OS,"time":chrono::Local::now().to_rfc3339()});
            body["personality"] = json!(true);
            self.state.borrow_mut().verity_busy = true;
            self.state
                .borrow_mut()
                .verity_messages
                .entry(id)
                .or_default()
                .push(json!({"role":"user","text":text}));
        }
        buffer.set_text("");
        self.state.borrow_mut().draft.remove(&conv);
        self.request(tag, conv.message_path(), Some(body));
        self.render_content();
    }
    fn event(self: &App, event: Event) {
        match event {
            Event::UpdateChecked { manual, result } => self.update_checked(manual, result),
            Event::UpdateProgress { done, total } => self.update_progress(done, total),
            Event::UpdatePrepared(result) => self.update_prepared(result),
            Event::VerityTool { turn, id, result } => self.verity_tool_done(turn, id, result),
            Event::ImagePrepared {
                kind,
                file,
                preview,
            } => self.crop_image(kind, file, preview),
            Event::Login { api, user } => {
                self.send(Command::Games(self.config.borrow().show_games));
                let _ = self.config.borrow().save();
                self.state.borrow_mut().auth_busy = false;
                self.state.borrow_mut().api = Some(api);
                self.state.borrow_mut().session = Some(Session {
                    me: *user,
                    ..Default::default()
                });
                self.shell();
                self.refresh();
            }
            Event::Connected(connected) => {
                self.state.borrow_mut().connected = connected;
                if self.state.borrow().session.is_some() {
                    self.render_sidebar();
                    if connected {
                        self.refresh();
                        if let Some(Conversation::Group(id)) = self.state.borrow().call {
                            self.socket(json!({"type":"gcall_join","group":id,"ring":false}));
                        }
                    }
                }
            }
            Event::Error { tag, message } => {
                if let Some(turn) = tag.strip_prefix("verity-continue:") {
                    if self.verity.borrow().turn != turn {
                        return;
                    }
                    self.cancel_verity();
                    self.state.borrow_mut().verity_busy = false;
                    self.render_content();
                }
                if let Some(path) = tag.strip_prefix("asset:") {
                    self.assets.borrow_mut().waiting.remove(path);
                    return;
                }
                if let Some(key) = tag.strip_prefix("history:") {
                    if let Some(c) = parse_conv(key) {
                        self.state.borrow_mut().loading.retain(|x| *x != c);
                    }
                }
                if tag == "auth" {
                    self.state.borrow_mut().auth_busy = false;
                    self.auth(&message);
                    return;
                }
                if tag == "session" {
                    self.logout();
                    self.auth(&message);
                    return;
                }
                if tag.starts_with("send:") {
                    let pending = self.state.borrow_mut().pending_send.remove(&tag);
                    if let Some((conv, text)) = pending {
                        if matches!(conv, Conversation::Verity(_)) {
                            self.state.borrow_mut().verity_busy = false;
                        }
                        self.state.borrow_mut().draft.insert(conv, text.clone());
                        if self.state.borrow().selected == Some(conv) {
                            self.composer.buffer().set_text(&text);
                        }
                    } else {
                        return;
                    }
                }
                if tag == "media" {
                    self.state.borrow_mut().joining = false;
                }
                if tag.starts_with("sound-") {
                    self.sound_save_failed();
                }
                self.toast(&message);
            }
            Event::Downloaded(dest) => {
                self.toast(&format!("Сохранено: {}", dest.display()));
            }
            Event::Asset { path, preview } => self.received_image(path, preview),
            Event::Sound {
                epoch,
                preview,
                clip,
                gain,
            } => self.received_sound(epoch, preview, clip, gain),
            Event::Ringtone { epoch, clip } => self.received_ringtone(epoch, clip),
            Event::Socket(data) => self.socket_event(data),
            Event::Media(event) => self.media_event(event),
            Event::Response { tag, data } => {
                if self.state.borrow().session.is_none() {
                    return;
                }
                if tag.starts_with("sound-") {
                    self.sound_response(&tag, data);
                } else if tag == "friends" {
                    if let Ok(f) = serde_json::from_value(data) {
                        self.state.borrow_mut().session.as_mut().unwrap().friends = f;
                        self.render_sidebar();
                        if self.state.borrow().selected.is_none() {
                            self.render_content();
                        }
                    }
                } else if tag == "groups" {
                    if let Ok(g) = serde_json::from_value(data) {
                        self.state.borrow_mut().session.as_mut().unwrap().groups = g;
                        let missing = {
                            let s = self.state.borrow();
                            let has = |id| {
                                s.session
                                    .as_ref()
                                    .unwrap()
                                    .groups
                                    .iter()
                                    .any(|g| g.id == id)
                            };
                            (
                                matches!(s.selected,Some(Conversation::Group(id)) if !has(id)),
                                matches!(s.call,Some(Conversation::Group(id)) if !has(id)),
                            )
                        };
                        if missing.0 {
                            self.select(None);
                        }
                        if missing.1 {
                            self.hangup(false);
                        }
                        self.render_sidebar();
                    }
                } else if let Some(key) = tag.strip_prefix("history:") {
                    if let (Some(conv), Ok(messages)) =
                        (parse_conv(key), serde_json::from_value(data))
                    {
                        let mut state = self.state.borrow_mut();
                        state.loading.retain(|c| *c != conv);
                        state
                            .session
                            .as_mut()
                            .unwrap()
                            .merge_history(conv, messages);
                        let selected = state.selected == Some(conv);
                        drop(state);
                        if selected {
                            self.render_content();
                        }
                    }
                } else if tag.starts_with("send:") {
                    let pending = self.state.borrow_mut().pending_send.remove(&tag);
                    if let Some((conv, _)) = pending {
                        if let Conversation::Verity(id) = conv {
                            self.state.borrow_mut().verity_busy = false;
                            let new_id = data["chat"]["id"].as_i64().unwrap_or(id);
                            if id != new_id {
                                let old = self
                                    .state
                                    .borrow_mut()
                                    .verity_messages
                                    .remove(&id)
                                    .unwrap_or_default();
                                self.state.borrow_mut().verity_messages.insert(new_id, old);
                                if self.state.borrow().selected == Some(conv) {
                                    self.state.borrow_mut().selected =
                                        Some(Conversation::Verity(new_id));
                                }
                            }
                            if data["message"].is_object() {
                                self.state
                                    .borrow_mut()
                                    .verity_messages
                                    .entry(new_id)
                                    .or_default()
                                    .push(data["message"].clone());
                            }
                            self.verity_response(new_id, &data);
                            self.render_content();
                        } else if let Ok(message) = serde_json::from_value(data) {
                            self.accept_message(message);
                        }
                    }
                } else if let Some(turn) = tag.strip_prefix("verity-continue:") {
                    if self.verity.borrow().turn != turn {
                        return;
                    }
                    let id = data["chat"]["id"].as_i64().unwrap_or_default();
                    if data["message"].is_object() {
                        self.state
                            .borrow_mut()
                            .verity_messages
                            .entry(id)
                            .or_default()
                            .push(data["message"].clone());
                    }
                    self.verity_response(id, &data);
                    self.render_content();
                } else if tag == "verity-stop" {
                    // Local cancellation already updated the UI; this may arrive
                    // after a newer turn has started.
                } else if tag == "me" {
                    if let Ok(user) = serde_json::from_value(data) {
                        self.state.borrow_mut().session.as_mut().unwrap().me = user;
                        self.render_sidebar();
                    }
                } else if tag.starts_with("profile:") {
                    self.profile_dialog(data);
                } else if let Some(key) = tag.strip_prefix("verity:") {
                    let requested = key.parse().unwrap_or(0);
                    let id = data["chat"].as_i64().unwrap_or(requested);
                    if let Some(chats) = data["chats"].as_array() {
                        self.state.borrow_mut().verity_chats = chats.clone();
                    }
                    if let Some(messages) = data["messages"].as_array() {
                        self.state
                            .borrow_mut()
                            .verity_messages
                            .insert(id, messages.clone());
                    }
                    if self.state.borrow().selected == Some(Conversation::Verity(requested)) {
                        self.state.borrow_mut().selected = Some(Conversation::Verity(id));
                        self.render_content();
                    }
                } else if tag == "gifs" {
                    self.gif_dialog(data);
                } else if tag == "upload" {
                    if let Ok(message) = serde_json::from_value(data) {
                        self.accept_message(message);
                    }
                    self.toast("Файл отправлен");
                } else if tag == "group-change" {
                    self.refresh();
                } else if tag == "password" {
                    self.toast("Пароль изменён. Войдите с новым паролем.");
                    self.logout();
                } else if tag == "delete" {
                    self.toast("Сообщение удалено");
                }
            }
        }
    }
    fn accept_message(self: &App, message: Message) {
        let notification = {
            let state = self.state.borrow();
            state.session.as_ref().and_then(|s| {
                let conv = message
                    .grp
                    .filter(|id| *id > 0)
                    .map(Conversation::Group)
                    .unwrap_or(Conversation::User(message.sender));
                if message.sender != s.me.id
                    && (state.selected != Some(conv) || !self.window.is_active())
                    && !s
                        .messages
                        .get(&conv)
                        .is_some_and(|list| list.iter().any(|m| m.id == message.id))
                    && s.me.status != "dnd"
                    && self.config.borrow().notifications
                {
                    Some((
                        conv,
                        s.title(conv),
                        message.text.chars().take(160).collect::<String>(),
                    ))
                } else {
                    None
                }
            })
        };
        let mut state = self.state.borrow_mut();
        let selected = state.selected;
        if let Some(session) = state.session.as_mut() {
            session.receive(message, selected);
        }
        drop(state);
        self.render_conversations();
        self.render_content();
        if let Some((conv, title, body)) = notification {
            self.cue(crate::audio::Cue::Message);
            if let Some(application) = self.window.application() {
                let notification = gio::Notification::new(&title);
                notification.set_body(Some(&body));
                notification.set_default_action_and_target_value(
                    "app.chat",
                    Some(&conv.key().to_variant()),
                );
                application.send_notification(Some(&conv.key()), &notification);
            }
        }
    }
    fn socket_event(self: &App, data: Value) {
        if self.state.borrow().session.is_none() {
            return;
        }
        match data["type"].as_str().unwrap_or_default() {
            "message" => {
                if let Ok(message) = serde_json::from_value(data["msg"].clone()) {
                    self.accept_message(message);
                }
            }
            "friends" => self.request("friends", "/api/friends", None),
            "groups" | "gcall" => self.request("groups", "/api/groups", None),
            "message_deleted" => {
                let mut state = self.state.borrow_mut();
                for list in state.session.as_mut().unwrap().messages.values_mut() {
                    list.retain(|m| Some(m.id) != data["id"].as_i64());
                }
                drop(state);
                self.render_content();
            }
            "game" => {
                if let Some(id) = data["userId"].as_i64() {
                    if let Ok(game) = serde_json::from_value::<Option<Game>>(data["game"].clone()) {
                        self.state
                            .borrow_mut()
                            .session
                            .as_mut()
                            .unwrap()
                            .set_game(id, game);
                        self.render_sidebar();
                        if self.state.borrow().selected.is_none() {
                            self.render_content();
                        }
                    }
                }
            }
            "presence" | "user" => self.request("friends", "/api/friends", None),
            "me" => {
                if let Ok(me) = serde_json::from_value(data["user"].clone()) {
                    self.state.borrow_mut().session.as_mut().unwrap().me = me;
                    self.render_sidebar();
                }
            }
            "call_invite" => {
                if let Some(id) = data["from"]["id"].as_i64() {
                    self.incoming(Conversation::User(id));
                }
            }
            "call_accept" => {
                self.state.borrow_mut().ringing = false;
            }
            "gcall_ring" => {
                if let Some(id) = data["group"].as_i64() {
                    self.incoming(Conversation::Group(id));
                }
            }
            "call_decline" | "call_end" => {
                if let Some(id) = data["from"]["id"].as_i64() {
                    if self.state.borrow().call == Some(Conversation::User(id)) {
                        self.hangup(false);
                    }
                    self.close_incoming();
                }
            }
            "call_accept_self" | "call_decline_self" | "call_end_self" => self.close_incoming(),
            _ => {}
        }
    }
    pub fn logout(self: &App) {
        self.cancel_verity();
        self.send(Command::Logout);
        self.close_incoming();
        let parent = self.window.clone().upcast::<gtk::Window>();
        for widget in gtk::Window::list_toplevels() {
            if let Ok(window) = widget.downcast::<gtk::Window>() {
                if window.transient_for().as_ref() == Some(&parent) {
                    window.close();
                }
            }
        }
        *self.state.borrow_mut() = State::default();
        clear(&self.sidebar);
        clear(&self.header);
        clear(&self.timeline);
        clear(&self.compose_box);
        clear(&self.call_box);
        clear(&self.videos);
        self.call_box.set_visible(false);
        self.pictures.borrow_mut().clear();
        self.assets.borrow_mut().clear();
        self.reset_sounds();
        self.auth("");
    }
    fn pick_upload(self: &App) {
        let Some(conv) = self.state.borrow().selected else {
            return;
        };
        let chooser = gtk::FileChooserNative::builder()
            .transient_for(&self.window)
            .title("Прикрепить файлы")
            .action(gtk::FileChooserAction::Open)
            .select_multiple(true)
            .build();
        let weak = Rc::downgrade(self);
        chooser.connect_response(move |d, response| {
            if response == gtk::ResponseType::Accept {
                if let Some(a) = weak.upgrade() {
                    let files = d.files();
                    for i in 0..files.n_items() {
                        if let Some(path) = files
                            .item(i)
                            .and_then(|f| f.downcast::<gio::File>().ok())
                            .and_then(|f| f.path())
                        {
                            a.send(Command::Upload { conv, file: path });
                            a.toast("Загружаю файл…");
                        }
                    }
                }
            }
            d.destroy();
        });
        chooser.show();
    }
    pub fn save_file(self: &App, file: &Attachment) {
        let chooser = gtk::FileChooserNative::builder()
            .transient_for(&self.window)
            .title("Сохранить файл")
            .action(gtk::FileChooserAction::Save)
            .build();
        chooser.set_current_name(&file.name);
        let id = file.id.clone();
        let weak = Rc::downgrade(self);
        chooser.connect_response(move |d, response| {
            if response == gtk::ResponseType::Accept {
                if let (Some(a), Some(dest)) = (weak.upgrade(), d.file().and_then(|f| f.path())) {
                    a.send(Command::Download {
                        id: id.clone(),
                        dest,
                    });
                    a.toast("Скачиваю файл…");
                }
            }
            d.destroy();
        });
        chooser.show();
    }
    pub fn call(self: &App, conv: Conversation, accept: bool) {
        if self.state.borrow().call.is_some() || self.state.borrow().joining {
            self.toast("Вы уже в звонке");
            return;
        }
        self.close_incoming();
        self.state.borrow_mut().joining = true;
        self.send(Command::Call {
            conv,
            accept,
            config: self.config.borrow().clone(),
        });
        self.toast("Подключение к звонку…");
    }
    pub fn hangup(self: &App, signal: bool) {
        if self.state.borrow().call.is_some() {
            self.cue(crate::audio::Cue::Disconnect);
        }
        self.stop_board();
        self.close_soundboard();
        if signal {
            if let Some(c) = self.state.borrow().call {
                match c {
                    Conversation::User(id) => self.socket(json!({"type":"call_end","to":id})),
                    Conversation::Group(id) => {
                        self.socket(json!({"type":"gcall_leave","group":id}))
                    }
                    _ => {}
                }
            }
        }
        self.state.borrow_mut().call = None;
        self.state.borrow_mut().joining = false;
        self.media(media::Command::Leave);
    }
    fn media_event(self: &App, event: media::Event) {
        if self.state.borrow().session.is_none() && !matches!(event, media::Event::Left) {
            self.media(media::Command::Leave);
            return;
        }
        match event {
            media::Event::Joined { conv, accept } => {
                if !self.state.borrow().joining {
                    self.media(media::Command::Leave);
                    return;
                }
                self.state.borrow_mut().joining = false;
                self.state.borrow_mut().call = Some(conv);
                self.state.borrow_mut().ringing = matches!(conv, Conversation::User(_)) && !accept;
                self.cue(crate::audio::Cue::Connect);
                let weak = Rc::downgrade(self);
                glib::timeout_add_local_once(Duration::from_secs(30), move || {
                    if let Some(a) = weak.upgrade() {
                        let no_answer = {
                            let s = a.state.borrow();
                            s.ringing && s.call == Some(conv)
                        };
                        if no_answer {
                            a.hangup(true);
                            a.toast("Нет ответа");
                        }
                    }
                });
                match conv {
                    Conversation::User(id) => self.socket(
                        json!({"type":if accept {"call_accept"} else {"call_invite"},"to":id}),
                    ),
                    Conversation::Group(id) => {
                        self.socket(json!({"type":"gcall_join","group":id,"ring":!accept}))
                    }
                    _ => {}
                }
                self.render_call();
                self.toast("");
            }
            media::Event::Left => {
                self.stop_board();
                self.close_soundboard();
                self.state.borrow_mut().participants.clear();
                self.state.borrow_mut().user_mutes.clear();
                let had_call = self.state.borrow().call.is_some() || self.state.borrow().joining;
                self.state.borrow_mut().call = None;
                self.state.borrow_mut().joining = false;
                self.state.borrow_mut().sharing = false;
                self.state.borrow_mut().ringing = false;
                self.pictures.borrow_mut().clear();
                clear(&self.videos);
                self.render_call();
                if had_call {
                    self.cue(crate::audio::Cue::Disconnect);
                    self.media(media::Command::Leave);
                }
            }
            media::Event::Participants(people) => {
                let previous = self
                    .state
                    .borrow()
                    .participants
                    .iter()
                    .map(|(id, _, _)| id.clone())
                    .collect::<Vec<_>>();
                let joined = people.iter().any(|(id, _, _)| !previous.contains(id));
                let left = previous
                    .iter()
                    .any(|id| !people.iter().any(|(p, _, _)| p == id));
                if self.state.borrow().call.is_some() && !previous.is_empty() {
                    if joined {
                        self.cue(crate::audio::Cue::Join);
                    } else if left {
                        self.cue(crate::audio::Cue::Leave);
                    }
                }
                if people.len() > 1 {
                    self.state.borrow_mut().ringing = false;
                }
                self.state.borrow_mut().participants = people;
                self.render_call();
            }
            media::Event::State(text) => self.toast(&text),
            media::Event::Screen(on) => {
                if self.state.borrow().sharing != on {
                    self.cue(if on {
                        crate::audio::Cue::StreamStart
                    } else {
                        crate::audio::Cue::StreamEnd
                    });
                }
                self.state.borrow_mut().sharing = on;
                self.render_call();
            }
            media::Event::Video {
                key,
                identity,
                label,
            } => {
                if self.pictures.borrow().contains_key(&key) {
                    return;
                }
                let frame = gtk::Box::new(gtk::Orientation::Vertical, 4);
                let title = label_(&label);
                frame.append(&title);
                let picture = gtk::Picture::new();
                picture.set_can_shrink(true);
                picture.set_size_request(320, 180);
                frame.append(&picture);
                self.video_menu(&frame, &key, &identity);
                self.videos.append(&frame);
                self.pictures.borrow_mut().insert(key, picture);
            }
            media::Event::VideoRemoved(key) => {
                if let Some(p) = self.pictures.borrow_mut().remove(&key) {
                    if let Some(parent) = p.parent() {
                        self.videos.remove(&parent);
                    }
                }
            }
            media::Event::Data { topic, data, from } => {
                if topic == "sb" {
                    self.board_received(&from, data);
                }
            }
            media::Event::Devices {
                microphones,
                outputs,
            } => self.audio_devices(microphones, outputs),
        }
    }
    fn render_call(self: &App) {
        clear(&self.call_box);
        let state = self.state.borrow();
        self.call_box.set_visible(state.call.is_some());
        let Some(conv) = state.call else { return };
        let title = state
            .session
            .as_ref()
            .map(|s| s.title(conv))
            .unwrap_or_default();
        self.call_box
            .append(&label(&format!("Голосовая связь · {title}"), "heading"));
        let people = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        for (id, name, speaking) in &state.participants {
            let tile = gtk::Box::new(gtk::Orientation::Vertical, 6);
            tile.add_css_class("tile");
            if *speaking {
                tile.add_css_class("speaking");
            }
            tile.append(&label(name, "heading"));
            if let Ok(id) = id.parse() {
                self.call_user_menu(&tile, id);
            }
            people.append(&tile);
        }
        self.call_box.append(&people);
        let controls = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let screen = button(
            if state.sharing {
                "Остановить показ"
            } else {
                "Показать экран"
            },
            "",
        );
        let leave = button("Завершить", "destructive-action");
        let soundboard = button("Звуковая панель", "");
        controls.append(&screen);
        controls.append(&soundboard);
        controls.append(&leave);
        self.call_box.append(&controls);
        drop(state);
        let weak = Rc::downgrade(self);
        soundboard.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.soundboard();
            }
        });
        let weak = Rc::downgrade(self);
        screen.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                if a.state.borrow().sharing {
                    a.media(media::Command::StopScreen);
                } else {
                    a.screen_dialog();
                }
            }
        });
        let weak = Rc::downgrade(self);
        leave.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.hangup(true);
            }
        });
    }
    fn draw_frames(&self) {
        let frames = std::mem::take(&mut *self.frames.lock().unwrap());
        for (key, frame) in frames {
            if let Some(picture) = self.pictures.borrow().get(&key) {
                let texture = gdk::MemoryTexture::new(
                    frame.width as i32,
                    frame.height as i32,
                    gdk::MemoryFormat::R8g8b8a8,
                    &glib::Bytes::from_owned(frame.rgba),
                    frame.width as usize * 4,
                );
                picture.set_paintable(Some(&texture));
            }
        }
    }
    fn incoming(self: &App, conv: Conversation) {
        if self.state.borrow().call.is_some() || self.state.borrow().incoming.is_some() {
            return;
        }
        let title = self
            .state
            .borrow()
            .session
            .as_ref()
            .map(|s| s.title(conv))
            .unwrap_or_default();
        let dialog = gtk::Window::builder()
            .title("Входящий звонок")
            .transient_for(&self.window)
            .modal(true)
            .default_width(360)
            .build();
        let box_ = gtk::Box::new(gtk::Orientation::Vertical, 18);
        margins(&box_, 24);
        box_.append(&label(&title, "title"));
        box_.append(&label("Входящий голосовой звонок…", "muted"));
        let accept = button("Принять", "suggested-action");
        let decline = button("Отклонить", "destructive-action");
        box_.append(&accept);
        box_.append(&decline);
        dialog.set_child(Some(&box_));
        self.state.borrow_mut().incoming = Some((conv, dialog.clone()));
        self.load_ringtone();
        self.sync_ringing();
        let weak = Rc::downgrade(self);
        dialog.connect_close_request(move |_| {
            if let Some(a) = weak.upgrade() {
                let incoming = a.state.borrow_mut().incoming.take();
                if incoming.is_some() {
                    if let Conversation::User(id) = conv {
                        a.socket(json!({"type":"call_decline","to":id}));
                    }
                }
            }
            glib::Propagation::Proceed
        });
        let weak = Rc::downgrade(self);
        accept.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                a.call(conv, true);
            }
        });
        let weak = Rc::downgrade(self);
        decline.connect_clicked(move |_| {
            if let Some(a) = weak.upgrade() {
                if let Conversation::User(id) = conv {
                    a.socket(json!({"type":"call_decline","to":id}));
                }
                a.close_incoming();
            }
        });
        let weak = Rc::downgrade(self);
        glib::timeout_add_local_once(Duration::from_secs(30), move || {
            if let Some(a) = weak.upgrade() {
                if a.state
                    .borrow()
                    .incoming
                    .as_ref()
                    .is_some_and(|(c, _)| *c == conv)
                {
                    a.close_incoming();
                }
            }
        });
        dialog.present();
    }
    fn close_incoming(&self) {
        let incoming = self.state.borrow_mut().incoming.take();
        if let Some((_, window)) = incoming {
            window.close();
        }
        self.sync_ringing();
    }
}

pub(super) fn clear(box_: &gtk::Box) {
    while let Some(child) = box_.first_child() {
        box_.remove(&child);
    }
}
pub(super) fn button(text: &str, class: &str) -> gtk::Button {
    let b = gtk::Button::with_label(text);
    if !class.is_empty() {
        b.add_css_class(class);
    }
    b
}
pub(super) fn label(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    if !class.is_empty() {
        l.add_css_class(class);
    }
    l
}
fn label_(text: &str) -> gtk::Label {
    label(text, "")
}
pub(super) fn margins(w: &impl IsA<gtk::Widget>, n: i32) {
    w.set_margin_top(n);
    w.set_margin_bottom(n);
    w.set_margin_start(n);
    w.set_margin_end(n);
}
fn parse_conv(key: &str) -> Option<Conversation> {
    let id = key.get(1..)?.parse().ok()?;
    match key.chars().next()? {
        'u' => Some(Conversation::User(id)),
        'g' => Some(Conversation::Group(id)),
        'v' => Some(Conversation::Verity(id)),
        _ => None,
    }
}
fn filesize(n: u64) -> String {
    if n < 1024 {
        format!("{n} Б")
    } else if n < 1048576 {
        format!("{:.1} КБ", n as f64 / 1024.)
    } else {
        format!("{:.1} МБ", n as f64 / 1048576.)
    }
}
fn replace_emoji_codes(text: &str) -> String {
    let data: Value = serde_json::from_str(include_str!("../emoji.json")).unwrap_or(Value::Null);
    let mut result = text.to_string();
    if let Some(list) = data["list"].as_array() {
        for row in list {
            if let (Some(emoji), Some(names)) = (row[0].as_str(), row[2].as_str()) {
                for name in names.split_whitespace() {
                    let code = format!(":{name}:");
                    if result.contains(&code) {
                        result = result.replace(&code, emoji);
                    }
                }
            }
        }
    }
    result
}
