use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct User {
    pub id: i64,
    pub username: String,
    #[serde(deserialize_with = "null_string")]
    pub display: String,
    #[serde(deserialize_with = "null_string")]
    pub bio: String,
    #[serde(deserialize_with = "null_string")]
    pub pronouns: String,
    #[serde(deserialize_with = "null_string")]
    pub custom: String,
    #[serde(deserialize_with = "null_string")]
    pub avatar: String,
    #[serde(deserialize_with = "null_string")]
    pub banner: String,
    #[serde(deserialize_with = "null_string")]
    pub bcolor: String,
    #[serde(deserialize_with = "null_string")]
    pub status: String,
    pub online: bool,
    pub created: i64,
    pub game: Option<Game>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct Game {
    pub name: String,
    pub start: i64,
    pub icon: String,
    pub app: String,
    pub steam: String,
}

impl Game {
    pub fn elapsed(&self, now: i64) -> String {
        let seconds = now.saturating_sub(self.start).max(0) / 1000;
        let hours = seconds / 3600;
        let clock = format!("{hours:02}:{:02}:{:02}", seconds / 60 % 60, seconds % 60);
        if hours >= 3 {
            format!("{clock} · {hours} ч марафон")
        } else {
            clock
        }
    }
}

fn null_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

impl User {
    pub fn visible_game(&self, me: i64) -> Option<&Game> {
        self.game.as_ref().filter(|game| {
            !game.name.trim().is_empty()
                && (self.id == me
                    || (self.online && !matches!(self.status.as_str(), "invisible" | "offline")))
        })
    }
    pub fn name(&self) -> &str {
        if self.display.is_empty() {
            &self.username
        } else {
            &self.display
        }
    }
    pub fn status_label(&self) -> &str {
        if !self.online {
            return "Не в сети";
        }
        match self.status.as_str() {
            "idle" => "Неактивен",
            "dnd" => "Не беспокоить",
            "invisible" | "offline" => "Невидимый",
            _ => "В сети",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Friends {
    pub friends: Vec<User>,
    pub incoming: Vec<User>,
    pub outgoing: Vec<User>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub owner: i64,
    pub members: Vec<User>,
    pub call: Vec<i64>,
}
impl Group {
    pub fn title(&self) -> String {
        if self.name.is_empty() {
            self.members
                .iter()
                .map(User::name)
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            self.name.clone()
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: u64,
    #[serde(rename = "type")]
    pub mime: String,
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub gif: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Message {
    pub id: i64,
    pub sender: i64,
    pub recipient: i64,
    pub text: String,
    pub created: i64,
    pub file: Option<Attachment>,
    pub grp: Option<i64>,
    pub kind: Option<String>,
    pub sname: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Conversation {
    User(i64),
    Group(i64),
    Verity(i64),
}
impl Conversation {
    pub fn key(self) -> String {
        match self {
            Self::User(id) => format!("u{id}"),
            Self::Group(id) => format!("g{id}"),
            Self::Verity(id) => format!("v{id}"),
        }
    }
    pub fn target(self) -> serde_json::Value {
        match self {
            Self::User(id) => serde_json::json!({"peer":id}),
            Self::Group(id) => serde_json::json!({"group":id}),
            Self::Verity(id) => serde_json::json!({"chat":id}),
        }
    }
    pub fn history_path(self) -> String {
        match self {
            Self::User(id) => format!("/api/dm/messages?peer={id}"),
            Self::Group(id) => format!("/api/group/messages?group={id}"),
            Self::Verity(id) => format!("/api/verity?chat={id}"),
        }
    }
    pub fn message_path(self) -> &'static str {
        match self {
            Self::User(_) => "/api/dm/messages",
            Self::Group(_) => "/api/group/messages",
            Self::Verity(_) => "/api/verity",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Session {
    pub me: User,
    pub friends: Friends,
    pub groups: Vec<Group>,
    pub messages: BTreeMap<Conversation, Vec<Message>>,
    pub unread: BTreeMap<Conversation, usize>,
}
impl Session {
    pub fn set_game(&mut self, id: i64, game: Option<Game>) {
        for user in std::iter::once(&mut self.me)
            .chain(self.friends.friends.iter_mut())
            .chain(self.friends.incoming.iter_mut())
            .chain(self.friends.outgoing.iter_mut())
            .chain(self.groups.iter_mut().flat_map(|g| g.members.iter_mut()))
        {
            if user.id == id {
                user.game = game.clone();
            }
        }
    }
    pub fn user(&self, id: i64) -> Option<&User> {
        std::iter::once(&self.me)
            .chain(self.friends.friends.iter())
            .chain(self.friends.incoming.iter())
            .chain(self.friends.outgoing.iter())
            .chain(self.groups.iter().flat_map(|g| g.members.iter()))
            .find(|u| u.id == id)
    }
    pub fn title(&self, c: Conversation) -> String {
        match c {
            Conversation::User(id) => self
                .user(id)
                .map(|u| u.name().to_string())
                .unwrap_or_else(|| format!("Пользователь {id}")),
            Conversation::Group(id) => self
                .groups
                .iter()
                .find(|g| g.id == id)
                .map(Group::title)
                .unwrap_or_else(|| "Группа".into()),
            Conversation::Verity(_) => "Верити".into(),
        }
    }
    pub fn receive(&mut self, message: Message, selected: Option<Conversation>) {
        let c = message
            .grp
            .filter(|id| *id > 0)
            .map(Conversation::Group)
            .unwrap_or(Conversation::User(if message.sender == self.me.id {
                message.recipient
            } else {
                message.sender
            }));
        let list = self.messages.entry(c).or_default();
        if list.iter().any(|m| m.id == message.id) {
            return;
        }
        let incoming = message.sender != self.me.id;
        list.push(message);
        list.sort_by_key(|m| m.id);
        if incoming && selected != Some(c) {
            *self.unread.entry(c).or_default() += 1;
        }
    }
    pub fn merge_history(&mut self, c: Conversation, mut history: Vec<Message>) {
        if let Some(live) = self.messages.remove(&c) {
            history.extend(live);
        }
        history.sort_by_key(|m| m.id);
        history.dedup_by_key(|m| m.id);
        self.messages.insert(c, history);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_messages_survive_history_race_without_duplicates() {
        let mut s = Session::default();
        s.me.id = 1;
        let c = Conversation::User(2);
        let m = |id| Message {
            id,
            sender: 2,
            recipient: 1,
            ..Default::default()
        };
        s.receive(m(11), None);
        s.receive(m(11), None);
        s.merge_history(c, vec![m(10), m(11)]);
        assert_eq!(
            s.messages[&c].iter().map(|m| m.id).collect::<Vec<_>>(),
            [10, 11]
        );
        assert_eq!(s.unread[&c], 1);
    }
    #[test]
    fn legacy_null_profile_fields_are_accepted() {
        let u: User =
            serde_json::from_str(r#"{"id":1,"username":"test","display":null,"status":null}"#)
                .unwrap();
        assert_eq!(u.name(), "test");
    }

    #[test]
    fn game_presence_updates_all_copies_and_respects_invisible_status() {
        let game = Game {
            name: "Game".into(),
            start: 1_000,
            ..Default::default()
        };
        assert_eq!(game.elapsed(500), "00:00:00");
        assert_eq!(game.elapsed(11_106_000), "03:05:05 · 3 ч марафон");
        assert_eq!(game.elapsed(90_001_000), "25:00:00 · 25 ч марафон");
        let mut user = User {
            id: 2,
            online: true,
            status: "online".into(),
            game: Some(game.clone()),
            ..Default::default()
        };
        assert!(user.visible_game(1).is_some());
        user.status = "invisible".into();
        assert!(user.visible_game(1).is_none());
        assert!(user.visible_game(2).is_some());
        let mut session = Session {
            me: user.clone(),
            ..Default::default()
        };
        session.friends.friends.push(user.clone());
        session.groups.push(Group {
            members: vec![user],
            ..Default::default()
        });
        session.set_game(2, None);
        assert!(session.me.game.is_none());
        assert!(session.friends.friends[0].game.is_none());
        assert!(session.groups[0].members[0].game.is_none());
    }
}
