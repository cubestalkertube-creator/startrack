// Startrack API: аккаунты, друзья, личные сообщения, группы и файлы, сигналинг звонков.
// Медиа (голос/видео/демонстрация) идёт через LiveKit SFU, здесь только выдаём токены.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || './data';
const SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const LK_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
// API LiveKit с этой же машины (LIVEKIT_URL — публичный адрес для клиентов)
const lk = new RoomServiceClient(process.env.LIVEKIT_API_HOST || 'http://127.0.0.1:7880', LK_KEY, LK_SECRET);
const MAX_GROUP = 10; // участников в группе, как в Discord

const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_FILE = 500 * 1024 * 1024;
const MIN_FREE = 1024 * 1024 * 1024; // сколько места оставляем на диске сервера

fs.mkdirSync(FILES_DIR, { recursive: true });
const RINGTONE = path.join(DATA_DIR, 'ringtone.mp3');
const db = new DatabaseSync(path.join(DATA_DIR, 'startrack.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pass TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  -- status: 'pending' (a -> b заявка) или 'accepted'
  CREATE TABLE IF NOT EXISTS friends (
    a INTEGER NOT NULL, b INTEGER NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (a, b)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender INTEGER NOT NULL, recipient INTEGER NOT NULL,
    text TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_pair ON messages (sender, recipient, id);
  -- вложения: сам файл лежит в DATA_DIR/files/<id>; w/h — размер картинки/видео для превью
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, sender INTEGER NOT NULL, recipient INTEGER NOT NULL,
    name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, w INTEGER, h INTEGER, created INTEGER NOT NULL
  );
  -- групповые чаты; name пустое — клиент показывает ники участников
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner INTEGER NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    grp INTEGER NOT NULL, uid INTEGER NOT NULL, joined INTEGER NOT NULL,
    PRIMARY KEY (grp, uid)
  );
  CREATE INDEX IF NOT EXISTS group_members_uid ON group_members (uid);
`);
const addColumn = (table, col, type) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addColumn('messages', 'file', 'TEXT');
// сообщения группы: recipient = 0, grp = id группы; kind — системное сообщение (create/add/leave/kick/rename/call)
addColumn('messages', 'grp', 'INTEGER');
addColumn('messages', 'kind', 'TEXT');
addColumn('files', 'grp', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS messages_grp ON messages (grp, id)');

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (username, pass, created) VALUES (?, ?, ?)'),
  rel: db.prepare('SELECT * FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
  addRel: db.prepare('INSERT INTO friends (a, b, status) VALUES (?, ?, ?)'),
  acceptRel: db.prepare("UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?"),
  delRel: db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
  relsOf: db.prepare(`
    SELECT f.a, f.b, f.status, u.id, u.username FROM friends f
    JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
    WHERE f.a = ? OR f.b = ?`),
  addMsg: db.prepare('INSERT INTO messages (sender, recipient, text, created, file, grp, kind) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  history: db.prepare(`
    SELECT m.*, f.name AS fname, f.size AS fsize, f.type AS ftype, f.w AS fw, f.h AS fh FROM messages m
    LEFT JOIN files f ON f.id = m.file
    WHERE ((m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ?)) AND m.grp IS NULL AND m.id < ?
    ORDER BY m.id DESC LIMIT 50`),
  // в группе показываем и ник автора: он мог уже выйти из группы
  groupHistory: db.prepare(`
    SELECT m.*, u.username AS sname, f.name AS fname, f.size AS fsize, f.type AS ftype, f.w AS fw, f.h AS fh FROM messages m
    LEFT JOIN files f ON f.id = m.file LEFT JOIN users u ON u.id = m.sender
    WHERE m.grp = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT 50`),
  addFile: db.prepare('INSERT INTO files (id, sender, recipient, name, size, type, w, h, created, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  file: db.prepare('SELECT * FROM files WHERE id = ?'),
  group: db.prepare('SELECT * FROM groups WHERE id = ?'),
  groupsOf: db.prepare('SELECT g.* FROM groups g JOIN group_members m ON m.grp = g.id WHERE m.uid = ? ORDER BY g.id'),
  members: db.prepare('SELECT u.id, u.username FROM group_members m JOIN users u ON u.id = m.uid WHERE m.grp = ? ORDER BY m.joined, m.uid'),
  isMember: db.prepare('SELECT 1 FROM group_members WHERE grp = ? AND uid = ?'),
  coMembers: db.prepare('SELECT DISTINCT b.uid FROM group_members a JOIN group_members b ON b.grp = a.grp AND b.uid != a.uid WHERE a.uid = ?'),
  addGroup: db.prepare('INSERT INTO groups (name, owner, created) VALUES (?, ?, ?)'),
  addMember: db.prepare('INSERT OR IGNORE INTO group_members (grp, uid, joined) VALUES (?, ?, ?)'),
  delMember: db.prepare('DELETE FROM group_members WHERE grp = ? AND uid = ?'),
  setOwner: db.prepare('UPDATE groups SET owner = ? WHERE id = ?'),
  rename: db.prepare('UPDATE groups SET name = ? WHERE id = ?'),
  groupFiles: db.prepare('SELECT id FROM files WHERE grp = ?'),
  delGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  delGroupMsgs: db.prepare('DELETE FROM messages WHERE grp = ?'),
  delGroupFiles: db.prepare('DELETE FROM files WHERE grp = ?'),
};

const msgOut = (m) => ({
  id: m.id, sender: m.sender, recipient: m.recipient, text: m.text, created: m.created,
  file: m.file ? { id: m.file, name: m.fname, size: m.fsize, type: m.ftype, w: m.fw, h: m.fh } : null,
  ...(m.grp ? { grp: m.grp, kind: m.kind || null, sname: m.sname } : {}),
});

// --- auth ---
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pass, salt, 32).toString('hex');
}
function checkPass(pass, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pass, salt, 32));
}
function sign(userId) {
  const body = `${userId}.${Date.now() + 30 * 864e5}`;
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token) {
  const [id, exp, sig] = String(token || '').split('.');
  if (!sig || Number(exp) < Date.now()) return null;
  const good = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return q.userById.get(Number(id)) || null;
}

// --- realtime ---
const sockets = new Map(); // userId -> Set<ws>
const online = (id) => sockets.has(id);
function push(userId, event) {
  const data = JSON.stringify(event);
  for (const ws of sockets.get(userId) || []) ws.send(data);
}
function friendIds(userId) {
  return q.relsOf.all(userId, userId, userId).filter((r) => r.status === 'accepted').map((r) => r.id);
}
// кому важен статус «в сети»: друзья и все, с кем есть общая группа
function contactIds(userId) {
  return [...new Set([...friendIds(userId), ...q.coMembers.all(userId).map((r) => r.uid)])];
}
function isFriend(a, b) {
  const r = q.rel.get(a, b, b, a);
  return r && r.status === 'accepted';
}
const roomFor = (a, b) => `dm_${Math.min(a, b)}_${Math.max(a, b)}`;
const groupRoom = (id) => `grp_${id}`;

// --- группы ---
const isMember = (gid, uid) => !!q.isMember.get(gid, uid);
const memberIds = (gid) => q.members.all(gid).map((u) => u.id);
function pushGroup(gid, event) {
  for (const id of memberIds(gid)) push(id, event);
}
function groupView(g) {
  return {
    id: g.id, name: g.name, owner: g.owner, call: callUsers(g.id),
    members: q.members.all(g.id).map((u) => ({ id: u.id, username: u.username, online: online(u.id) })),
  };
}
function memberGroup(me, gid) {
  const g = q.group.get(Number(gid));
  if (!g || !isMember(g.id, me.id)) throw [404, 'Группа не найдена'];
  return g;
}
// Сообщение в группу (и системное: «X добавил(а) Y» и т.п.) — всем участникам через WebSocket
function groupMsg(gid, sender, text, kind = null, file = null) {
  const created = Date.now();
  const { lastInsertRowid } = q.addMsg.run(sender.id, 0, text, created, file?.id ?? null, gid, kind);
  const msg = { id: Number(lastInsertRowid), sender: sender.id, recipient: 0, text, created, file, grp: gid, kind, sname: sender.username };
  pushGroup(gid, { type: 'message', msg });
  return msg;
}
// Друзья, которых можно добавить в группу: только свои друзья, без повторов
function pickFriends(me, ids, already = []) {
  const out = [];
  for (const id of new Set((Array.isArray(ids) ? ids : []).map(Number))) {
    if (already.includes(id) || id === me.id) continue;
    if (!isFriend(me.id, id)) throw [403, 'Добавлять в группу можно только друзей'];
    out.push(q.userById.get(id));
  }
  return out;
}
function dropGroup(gid) {
  for (const f of q.groupFiles.all(gid)) fs.rmSync(path.join(FILES_DIR, f.id), { force: true });
  q.delGroupFiles.run(gid);
  q.delGroupMsgs.run(gid);
  q.delGroup.run(gid);
}

// Групповые звонки: кто сейчас в звонке, знаем по WebSocket-соединениям (клиент сообщает gcall_join/gcall_leave)
const gcalls = new Map(); // id группы -> Set<ws>
const callUsers = (gid) => [...new Set([...(gcalls.get(gid) || [])].map((ws) => ws.uid))];
function setGcall(ws, gid) {
  const prev = ws.gcall || 0;
  if (prev === gid) return;
  ws.gcall = gid;
  if (prev) {
    gcalls.get(prev)?.delete(ws);
    if (!gcalls.get(prev)?.size) gcalls.delete(prev);
    pushGroup(prev, { type: 'gcall', group: prev, users: callUsers(prev) });
  }
  if (gid) {
    if (!gcalls.has(gid)) gcalls.set(gid, new Set());
    gcalls.get(gid).add(ws);
    pushGroup(gid, { type: 'gcall', group: gid, users: callUsers(gid) });
  }
}
// Убрать человека из звонка группы (вышел или исключили)
function kickFromCall(gid, uid) {
  for (const ws of sockets.get(uid) || []) if (ws.gcall === gid) setGcall(ws, 0);
  lk.removeParticipant(groupRoom(gid), String(uid)).catch(() => {}); // не в комнате — LiveKit ответит ошибкой
}

function friendsView(userId) {
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const r of q.relsOf.all(userId, userId, userId)) {
    const u = { id: r.id, username: r.username, online: online(r.id) };
    if (r.status === 'accepted') out.friends.push(u);
    else if (r.b === userId) out.incoming.push(u);
    else out.outgoing.push(u);
  }
  return out;
}

// --- http ---
const routes = {
  'POST /api/register': async (_u, b) => {
    const username = String(b.username || '').trim();
    if (!/^[\p{L}\d_.-]{2,32}$/u.test(username)) throw [400, 'Ник: 2-32 символа, буквы/цифры/_.-'];
    if (String(b.password || '').length < 6) throw [400, 'Пароль минимум 6 символов'];
    if (q.userByName.get(username)) throw [409, 'Ник занят'];
    const { lastInsertRowid } = q.addUser.run(username, hashPass(b.password), Date.now());
    return { token: sign(Number(lastInsertRowid)), user: { id: Number(lastInsertRowid), username } };
  },
  'POST /api/login': async (_u, b) => {
    const u = q.userByName.get(String(b.username || '').trim());
    if (!u || !checkPass(String(b.password || ''), u.pass)) throw [401, 'Неверный ник или пароль'];
    return { token: sign(u.id), user: { id: u.id, username: u.username } };
  },
  'GET /api/me': async (me) => me,
  'GET /api/friends': async (me) => friendsView(me.id),
  'POST /api/friends/request': async (me, b) => {
    const t = q.userByName.get(String(b.username || '').trim());
    if (!t) throw [404, 'Пользователь не найден'];
    if (t.id === me.id) throw [400, 'Нельзя добавить себя'];
    const r = q.rel.get(me.id, t.id, t.id, me.id);
    if (r?.status === 'accepted') throw [409, 'Уже в друзьях'];
    if (r && r.a === t.id) q.acceptRel.run(t.id, me.id); // встречная заявка = принять
    else if (!r) q.addRel.run(me.id, t.id, 'pending');
    push(t.id, { type: 'friends' });
    return friendsView(me.id);
  },
  'POST /api/friends/accept': async (me, b) => {
    q.acceptRel.run(Number(b.userId), me.id);
    push(Number(b.userId), { type: 'friends' });
    return friendsView(me.id);
  },
  'POST /api/friends/remove': async (me, b) => {
    const id = Number(b.userId);
    q.delRel.run(me.id, id, id, me.id);
    push(id, { type: 'friends' });
    return friendsView(me.id);
  },
  'GET /api/dm/messages': async (me, _b, url) => {
    const peer = Number(url.searchParams.get('peer'));
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return q.history.all(me.id, peer, peer, me.id, before).reverse().map(msgOut);
  },
  'POST /api/dm/messages': async (me, b) => {
    const peer = Number(b.peer);
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) throw [400, 'Пустое сообщение'];
    if (!isFriend(me.id, peer)) throw [403, 'Писать можно только друзьям'];
    const created = Date.now();
    const { lastInsertRowid } = q.addMsg.run(me.id, peer, text, created, null, null, null);
    const msg = { id: Number(lastInsertRowid), sender: me.id, recipient: peer, text, created, file: null };
    push(peer, { type: 'message', msg });
    push(me.id, { type: 'message', msg });
    return msg;
  },
  'GET /api/groups': async (me) => q.groupsOf.all(me.id).map(groupView),
  // Новая группа из друзей; имя можно не задавать
  'POST /api/groups/create': async (me, b) => {
    const users = pickFriends(me, b.users);
    if (!users.length) throw [400, 'Выберите хотя бы одного друга'];
    if (users.length + 1 > MAX_GROUP) throw [400, `В группе не больше ${MAX_GROUP} участников`];
    const now = Date.now();
    const gid = Number(q.addGroup.run(String(b.name || '').trim().slice(0, 100), me.id, now).lastInsertRowid);
    for (const u of [me, ...users]) q.addMember.run(gid, u.id, now);
    groupMsg(gid, me, '', 'create');
    pushGroup(gid, { type: 'groups' });
    return groupView(q.group.get(gid));
  },
  // Любой участник может добавить в группу своих друзей
  'POST /api/groups/add': async (me, b) => {
    const g = memberGroup(me, b.group);
    const ids = memberIds(g.id);
    const users = pickFriends(me, b.users, ids);
    if (!users.length) throw [400, 'Выберите друзей'];
    if (ids.length + users.length > MAX_GROUP) throw [400, `В группе не больше ${MAX_GROUP} участников`];
    for (const u of users) {
      q.addMember.run(g.id, u.id, Date.now());
      groupMsg(g.id, me, u.username, 'add');
    }
    pushGroup(g.id, { type: 'groups' });
    return groupView(g);
  },
  // Выйти самому или исключить участника (исключать может только владелец)
  'POST /api/groups/remove': async (me, b) => {
    const g = memberGroup(me, b.group);
    const uid = Number(b.user) || me.id;
    const self = uid === me.id;
    if (!self && g.owner !== me.id) throw [403, 'Исключать может только владелец группы'];
    const u = q.userById.get(uid);
    if (!u || !isMember(g.id, uid)) throw [404, 'Участник не найден'];
    groupMsg(g.id, me, u.username, self ? 'leave' : 'kick');
    q.delMember.run(g.id, uid);
    kickFromCall(g.id, uid);
    push(uid, { type: 'groups' });
    const rest = memberIds(g.id);
    if (!rest.length) dropGroup(g.id);
    else {
      if (g.owner === uid) q.setOwner.run(rest[0], g.id); // владелец ушёл — группа переходит следующему
      pushGroup(g.id, { type: 'groups' });
    }
    return { ok: true };
  },
  'POST /api/groups/rename': async (me, b) => {
    const g = memberGroup(me, b.group);
    const name = String(b.name || '').trim().slice(0, 100);
    if (name === g.name) return groupView(g);
    q.rename.run(name, g.id);
    groupMsg(g.id, me, name, 'rename');
    pushGroup(g.id, { type: 'groups' });
    return groupView(q.group.get(g.id));
  },
  'GET /api/group/messages': async (me, _b, url) => {
    const g = memberGroup(me, url.searchParams.get('group'));
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return q.groupHistory.all(g.id, before).reverse().map(msgOut);
  },
  'POST /api/group/messages': async (me, b) => {
    const g = memberGroup(me, b.group);
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) throw [400, 'Пустое сообщение'];
    return groupMsg(g.id, me, text);
  },
  // Токен в LiveKit-комнату звонка с другом или в группе
  'POST /api/call/token': async (me, b) => {
    let room;
    if (b.group) room = groupRoom(memberGroup(me, b.group).id);
    else {
      const peer = Number(b.peer);
      if (!isFriend(me.id, peer)) throw [403, 'Звонить можно только друзьям'];
      room = roomFor(me.id, peer);
    }
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity: String(me.id), name: me.username, ttl: '6h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return { url: LK_URL, token: await at.toJwt(), room };
  },
};

const bearer = (req) => (req.headers.authorization || '').replace('Bearer ', '');

// Отправка файла в личку (?peer=) или в группу (?group=): тело запроса — сам файл, имя и размеры
// превью — в параметрах. Пишем потоком сразу на диск, в память файл целиком не попадает.
async function uploadFile(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const gid = Number(url.searchParams.get('group')) || 0;
  const peer = gid ? 0 : Number(url.searchParams.get('peer'));
  if (gid && !isMember(gid, me.id)) return send(404, { error: 'Группа не найдена' });
  if (!gid && !isFriend(me.id, peer)) return send(403, { error: 'Отправлять файлы можно только друзьям' });
  const size = Number(req.headers['content-length']);
  if (!size) return send(400, { error: 'Пустой файл' });
  if (size > MAX_FILE) return send(413, { error: `Файл больше ${MAX_FILE / 1048576} МБ` });
  const disk = fs.statfsSync(FILES_DIR);
  if (disk.bavail * disk.bsize - size < MIN_FREE) return send(507, { error: 'На сервере закончилось место' });
  const name = String(url.searchParams.get('name') || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 200) || 'file';
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(ct) ? ct : 'application/octet-stream';
  const dim = (k) => { const v = Math.round(Number(url.searchParams.get(k))); return v > 0 && v < 1e5 ? v : null; };
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(FILES_DIR, id);
  let got = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) {
        got += chunk.length;
        if (got > size) throw new Error('too long');
        yield chunk;
      }
    }, fs.createWriteStream(file + '.part'));
    if (got !== size) throw new Error('incomplete');
    fs.renameSync(file + '.part', file);
  } catch {
    fs.rmSync(file + '.part', { force: true });
    return res.headersSent || res.destroyed || send(400, { error: 'Загрузка прервалась' });
  }
  const created = Date.now();
  const meta = { id, name, size, type, w: dim('w'), h: dim('h') };
  // из группы могли выйти, пока файл грузился
  if (gid && !isMember(gid, me.id)) { fs.rmSync(file, { force: true }); return send(404, { error: 'Группа не найдена' }); }
  q.addFile.run(id, me.id, peer, name, size, type, meta.w, meta.h, created, gid || null);
  if (gid) return send(200, groupMsg(gid, me, '', null, meta));
  const { lastInsertRowid } = q.addMsg.run(me.id, peer, '', created, id, null, null);
  const msg = { id: Number(lastInsertRowid), sender: me.id, recipient: peer, text: '', created, file: meta };
  push(peer, { type: 'message', msg });
  push(me.id, { type: 'message', msg });
  send(200, msg);
}

// Картинки, видео и звук показываем прямо в чате, остальное — только скачивание
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg)|audio\/[\w.+-]+)$/;

// Скачивание вложения (с Range — чтобы видео можно было перематывать). Токен можно передать
// в ?token=, т.к. <img>/<video> не умеют слать заголовок Authorization. ?dl — всегда как файл.
function downloadFile(req, res, url, id, send) {
  const me = verify(bearer(req) || url.searchParams.get('token'));
  if (!me) return send(401, { error: 'Нужно войти' });
  const f = q.file.get(id);
  const allowed = f && (f.grp ? isMember(f.grp, me.id) : f.sender === me.id || f.recipient === me.id);
  if (!allowed) return send(404, { error: 'Файл не найден' });
  const inline = INLINE.test(f.type) && !url.searchParams.has('dl');
  const ascii = f.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const headers = {
    'Content-Type': inline ? f.type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };
  let start = 0, end = f.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else start = Math.max(0, f.size - Number(range[2]));
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${f.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.size}` });
  } else res.writeHead(200, { ...headers, 'Content-Length': f.size });
  const stream = fs.createReadStream(path.join(FILES_DIR, id), { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Access-Control-Expose-Headers', 'X-Ringtone-Version, Content-Range');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return send(200, { ok: true });
  // Общая мелодия входящего звонка: файл кладёт админ в DATA_DIR/ringtone.mp3, отдаём только вошедшим
  if (url.pathname === '/api/ringtone' && req.method === 'GET') {
    if (!verify(bearer(req))) return send(401, { error: 'Нужно войти' });
    let st;
    try { st = fs.statSync(RINGTONE); } catch { return send(404, { error: 'Мелодия не задана' }); }
    const version = String(Math.floor(st.mtimeMs));
    if (url.searchParams.has('version')) return send(200, { version });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, 'X-Ringtone-Version': version });
    return fs.createReadStream(RINGTONE).pipe(res);
  }
  if (url.pathname === '/api/dm/file' && req.method === 'POST') return uploadFile(req, res, url, send);
  const fileId = /^\/api\/files\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
  if (fileId && req.method === 'GET') return downloadFile(req, res, url, fileId, send);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(404, { error: 'Not found' });
  try {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1e5) throw [413, 'Слишком большой запрос'];
      }
      body = raw ? JSON.parse(raw) : {};
    }
    const open = url.pathname === '/api/register' || url.pathname === '/api/login';
    const me = open ? null : verify(bearer(req));
    if (!open && !me) throw [401, 'Нужно войти'];
    send(200, await handler(me, body, url));
  } catch (e) {
    if (Array.isArray(e)) return send(e[0], { error: e[1] });
    console.error(e);
    send(500, { error: 'Ошибка сервера' });
  }
});

// по умолчанию Node рвёт запрос через 5 минут — большой файл по медленному каналу не успел бы загрузиться
server.requestTimeout = 3 * 3600e3;

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const me = verify(new URL(req.url, 'http://x').searchParams.get('token'));
  if (!me) return ws.close(4001, 'unauthorized');
  const wasOnline = online(me.id);
  if (!sockets.has(me.id)) sockets.set(me.id, new Set());
  sockets.get(me.id).add(ws);
  ws.uid = me.id;
  if (!wasOnline) for (const f of contactIds(me.id)) push(f, { type: 'presence', userId: me.id, online: true });

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // Сигналинг звонков: invite / accept / decline / end пересылаем другу
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // Групповой звонок: вошёл / вышел. ring — первый вошедший звонит остальным
    if (m.type === 'gcall_join' || m.type === 'gcall_leave') {
      const gid = Number(m.group);
      const g = q.group.get(gid);
      if (!g || !isMember(gid, me.id)) return;
      if (m.type === 'gcall_leave') return ws.gcall === gid && setGcall(ws, 0);
      const fresh = callUsers(gid).length === 0;
      setGcall(ws, gid);
      if (fresh && m.ring) {
        groupMsg(gid, me, '', 'call');
        for (const id of memberIds(gid)) if (id !== me.id) push(id, { type: 'gcall_ring', group: gid, from: { id: me.id, username: me.username } });
      }
      return;
    }
    const to = Number(m.to);
    if (!['call_invite', 'call_accept', 'call_decline', 'call_end'].includes(m.type) || !isFriend(me.id, to)) return;
    push(to, { type: m.type, from: { id: me.id, username: me.username } });
    // остальные вкладки/устройства звонящего тоже должны убрать окно входящего звонка
    if (m.type !== 'call_invite') push(me.id, { type: m.type + '_self', peer: to });
  });
  ws.on('close', () => {
    setGcall(ws, 0);
    const set = sockets.get(me.id);
    set?.delete(ws);
    if (set && set.size === 0) {
      sockets.delete(me.id);
      for (const f of contactIds(me.id)) push(f, { type: 'presence', userId: me.id, online: false });
    }
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Startrack API on :${PORT}, LiveKit ${LK_URL}`));
