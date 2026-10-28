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
// профиль как в Discord: отображаемое имя, «обо мне», местоимения, свой статус («пузырь» у аватарки),
// аватарка и баннер (файлы в DATA_DIR/avatars) или цвет баннера; status — выбранный онлайн-статус
for (const col of ['display', 'bio', 'pronouns', 'custom', 'avatar', 'banner', 'bcolor', 'status']) addColumn('users', col, 'TEXT');
// sha256 гифки во вложении: по нему клиент видит, что она уже в избранном
addColumn('files', 'gif', 'TEXT');
db.exec(`
  -- избранные гифки; файл — DATA_DIR/gifs/<hash>.gif, одинаковые гифки хранятся один раз
  CREATE TABLE IF NOT EXISTS gifs (
    uid INTEGER NOT NULL, hash TEXT NOT NULL, w INTEGER, h INTEGER, size INTEGER NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (uid, hash)
  );
  -- звуки звуковой панели: файл DATA_DIR/sounds/<file>, vol — громкость 0..1
  CREATE TABLE IF NOT EXISTS sounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL,
    file TEXT NOT NULL, vol REAL NOT NULL, created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sounds_uid ON sounds (uid);
  -- журнал действий админа
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, target INTEGER, details TEXT
  );
`);
// banned — когда заблокирован (NULL — нет); tokver — версия токенов, +1 = выйти на всех устройствах;
// seen — последняя активность (вход, подключение и отключение WebSocket)
addColumn('users', 'banned', 'INTEGER');
addColumn('users', 'ban_reason', 'TEXT');
addColumn('users', 'tokver', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'seen', 'INTEGER');

const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const GIFS_DIR = path.join(DATA_DIR, 'gifs');
const SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
for (const dir of [AVATARS_DIR, GIFS_DIR, SOUNDS_DIR]) fs.mkdirSync(dir, { recursive: true });
const MAX_GIF = 25 * 1024 * 1024;
const MAX_GIFS = 500; // избранных гифок у одного человека
const MAX_SOUND = 1024 * 1024;
const MAX_SOUNDS = 50;
const SOUND_EXT = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };
const MAX_IMAGE = 8 * 1024 * 1024;
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// поля пользователя, которые видят другие
const PUB = ['id', 'username', 'display', 'bio', 'pronouns', 'custom', 'avatar', 'banner', 'bcolor', 'status', 'created'];
const cols = (t) => PUB.map((c) => `${t}.${c}`).join(', ');

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare(`SELECT ${cols('users')} FROM users WHERE id = ?`),
  userPassById: db.prepare('SELECT pass, tokver FROM users WHERE id = ?'),
  setPass: db.prepare('UPDATE users SET pass = ?, tokver = tokver + 1 WHERE id = ?'),
  authUser: db.prepare(`SELECT ${cols('users')}, banned, tokver FROM users WHERE id = ?`),
  seen: db.prepare('UPDATE users SET seen = ? WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (username, pass, created) VALUES (?, ?, ?)'),
  setProfile: db.prepare('UPDATE users SET display = ?, bio = ?, pronouns = ?, custom = ?, bcolor = ? WHERE id = ?'),
  setImage: { avatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'), banner: db.prepare('UPDATE users SET banner = ? WHERE id = ?') },
  setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  rel: db.prepare('SELECT * FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
  addRel: db.prepare('INSERT INTO friends (a, b, status) VALUES (?, ?, ?)'),
  acceptRel: db.prepare("UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ?"),
  delRel: db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
  relsOf: db.prepare(`
    SELECT f.a, f.b, f.status AS rel, ${cols('u')} FROM friends f
    JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
    WHERE f.a = ? OR f.b = ?`),
  addMsg: db.prepare('INSERT INTO messages (sender, recipient, text, created, file, grp, kind) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  msg: db.prepare('SELECT * FROM messages WHERE id = ?'),
  delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
  delFile: db.prepare('DELETE FROM files WHERE id = ?'),
  history: db.prepare(`
    SELECT m.*, f.name AS fname, f.size AS fsize, f.type AS ftype, f.w AS fw, f.h AS fh, f.gif AS fgif FROM messages m
    LEFT JOIN files f ON f.id = m.file
    WHERE ((m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ?)) AND m.grp IS NULL AND m.id < ?
    ORDER BY m.id DESC LIMIT 50`),
  // в группе показываем и ник автора: он мог уже выйти из группы
  groupHistory: db.prepare(`
    SELECT m.*, u.username AS sname, f.name AS fname, f.size AS fsize, f.type AS ftype, f.w AS fw, f.h AS fh, f.gif AS fgif FROM messages m
    LEFT JOIN files f ON f.id = m.file LEFT JOIN users u ON u.id = m.sender
    WHERE m.grp = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT 50`),
  addFile: db.prepare('INSERT INTO files (id, sender, recipient, name, size, type, w, h, created, grp, gif) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  file: db.prepare('SELECT * FROM files WHERE id = ?'),
  setFileGif: db.prepare('UPDATE files SET gif = ? WHERE id = ?'),
  gifs: db.prepare('SELECT hash, w, h FROM gifs WHERE uid = ? ORDER BY created DESC'),
  gif: db.prepare('SELECT * FROM gifs WHERE uid = ? AND hash = ?'),
  gifCount: db.prepare('SELECT COUNT(*) AS n FROM gifs WHERE uid = ?'),
  gifUsers: db.prepare('SELECT COUNT(*) AS n FROM gifs WHERE hash = ?'),
  addGif: db.prepare('INSERT OR IGNORE INTO gifs (uid, hash, w, h, size, created) VALUES (?, ?, ?, ?, ?, ?)'),
  delGif: db.prepare('DELETE FROM gifs WHERE uid = ? AND hash = ?'),
  soundsOf: db.prepare('SELECT id, uid, name, emoji, file, vol FROM sounds WHERE uid = ? ORDER BY id'),
  sound: db.prepare('SELECT * FROM sounds WHERE id = ?'),
  soundCount: db.prepare('SELECT COUNT(*) AS n FROM sounds WHERE uid = ?'),
  addSound: db.prepare('INSERT INTO sounds (uid, name, emoji, file, vol, created) VALUES (?, ?, ?, ?, ?, ?)'),
  editSound: db.prepare('UPDATE sounds SET name = ?, emoji = ?, vol = ? WHERE id = ?'),
  delSound: db.prepare('DELETE FROM sounds WHERE id = ?'),
  group: db.prepare('SELECT * FROM groups WHERE id = ?'),
  groupsOf: db.prepare('SELECT g.* FROM groups g JOIN group_members m ON m.grp = g.id WHERE m.uid = ? ORDER BY g.id'),
  members: db.prepare(`SELECT ${cols('u')} FROM group_members m JOIN users u ON u.id = m.uid WHERE m.grp = ? ORDER BY m.joined, m.uid`),
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
  file: m.file ? { id: m.file, name: m.fname, size: m.fsize, type: m.ftype, w: m.fw, h: m.fh, gif: m.fgif || null } : null,
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
// Версия токенов (tokver) входит в подпись, поэтому «выйти везде» — просто tokver + 1.
// При tokver = 0 подпись прежняя: токены, выданные до появления версий, продолжают работать
const mac = (body, ver) => crypto.createHmac('sha256', SECRET).update(ver ? `${body}.${ver}` : body).digest('base64url');
function sign(userId, ver = 0) {
  const body = `${userId}.${Date.now() + 30 * 864e5}`;
  return body + '.' + mac(body, ver);
}
function verify(token) {
  const [id, exp, sig] = String(token || '').split('.');
  if (!sig || Number(exp) < Date.now()) return null;
  const u = q.authUser.get(Number(id));
  if (!u || u.banned) return null;
  const good = mac(`${id}.${exp}`, u.tokver);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return u;
}

// --- realtime ---
const sockets = new Map(); // userId -> Set<ws>
const online = (id) => sockets.has(id);
function push(userId, event) {
  const data = JSON.stringify(event);
  for (const ws of sockets.get(userId) || []) ws.send(data);
}
function friendIds(userId) {
  return q.relsOf.all(userId, userId, userId).filter((r) => r.rel === 'accepted').map((r) => r.id);
}
// кому важен статус «в сети»: друзья и все, с кем есть общая группа
function contactIds(userId) {
  return [...new Set([...friendIds(userId), ...q.coMembers.all(userId).map((r) => r.uid)])];
}

// --- профиль и статус ---
// Статус для других: нет соединения или «невидимка» — не в сети; «в сети», но давно не трогал ПК — неактивен
const afk = (id) => [...(sockets.get(id) || [])].every((ws) => ws.afk);
function statusOf(u) {
  if (!online(u.id) || u.status === 'invisible') return 'offline';
  const s = STATUSES.includes(u.status) ? u.status : 'online';
  return s === 'online' && afk(u.id) ? 'idle' : s;
}
// online оставлен для клиентов до 0.1.7
function pub(u) {
  const status = statusOf(u);
  return {
    id: u.id, username: u.username, display: u.display || '', bio: u.bio || '', pronouns: u.pronouns || '',
    custom: u.custom || '', avatar: u.avatar || '', banner: u.banner || '', bcolor: u.bcolor || '',
    created: u.created, status, online: status !== 'offline',
    game: status === 'offline' ? null : gameOf(u.id),
  };
}
// себе показываем выбранный статус (в том числе «невидимку»)
const selfView = (u) => ({ ...pub(u), status: STATUSES.includes(u.status) ? u.status : 'online', online: true, game: gameOf(u.id) });

const shown = new Map(); // id -> статус, который последним разослали контактам
function announce(id) {
  const u = q.userById.get(id);
  if (!u) return;
  const status = statusOf(u);
  if (shown.get(id) === status) return;
  shown.set(id, status);
  for (const f of contactIds(id)) push(f, { type: 'presence', userId: id, online: status !== 'offline', status });
}
// Профиль изменился: контактам — как его видят они, своим вкладкам и устройствам — целиком
function pushProfile(id) {
  const u = q.userById.get(id);
  const view = pub(u);
  for (const f of contactIds(id)) push(f, { type: 'user', user: view });
  push(id, { type: 'me', user: selfView(u) });
}
// --- «Играет в …», как в Discord ---
// Приложение раз в 15 секунд присылает хвосты путей запущенных программ (последние 4 части, без
// имени пользователя) и время их запуска, для Steam-игр — appid и название из appmanifest. Сверяем
// с базой игр Discord (applications/detectable, обновляем раз в сутки). Кто во что играет, держим
// только в памяти, список процессов нигде не сохраняем
const GAMES_DB = path.join(DATA_DIR, 'detectable.json');
const GAME_ICONS_DIR = path.join(DATA_DIR, 'game-icons');
fs.mkdirSync(GAME_ICONS_DIR, { recursive: true });
const G = { byExe: new Map(), apps: new Map(), bySteam: new Map() };
function indexGames(list) {
  const byExe = new Map(), apps = new Map(), bySteam = new Map();
  for (const a of list) {
    if (!a?.id || !a.name) continue;
    const steam = String(a.third_party_skus?.find((x) => x.distributor === 'steam')?.id || '');
    apps.set(a.id, { name: String(a.name).slice(0, 100), icon: a.icon_hash || '', steam });
    if (/^\d+$/.test(steam)) bySteam.set(steam, a.id);
    for (const e of a.executables || []) {
      if (e.os !== 'win32' || e.is_launcher || !e.name) continue;
      // «>hl2.exe» — только точное имя файла, без папки
      const exact = e.name.startsWith('>');
      const name = e.name.replace(/^>/, '').toLowerCase().replace(/\\/g, '/');
      const base = name.split('/').pop();
      if (!byExe.has(base)) byExe.set(base, []);
      byExe.get(base).push({ id: a.id, name, exact });
    }
  }
  Object.assign(G, { byExe, apps, bySteam });
}
async function loadGames() {
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(GAMES_DB).mtimeMs < 864e5; } catch {}
  if (!fresh) {
    try {
      const r = await fetch('https://discord.com/api/v10/applications/detectable', { signal: AbortSignal.timeout(60e3) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (!Array.isArray(JSON.parse(text))) throw new Error('не список');
      fs.writeFileSync(GAMES_DB + '.tmp', text);
      fs.renameSync(GAMES_DB + '.tmp', GAMES_DB);
    } catch (e) { console.error('База игр не обновилась:', e.message); }
  }
  try { indexGames(JSON.parse(fs.readFileSync(GAMES_DB, 'utf8'))); } catch {}
}
loadGames();
setInterval(loadGames, 864e5);

// Одна программа: p — хвост пути (a/b/game.exe), steam — [appid, название] из appmanifest
function matchProc(proc) {
  const p = String(proc?.p || '').toLowerCase().replace(/\\/g, '/').slice(-300);
  const steamId = /^\d{1,10}$/.test(String(proc?.steam?.[0] || '')) ? String(proc.steam[0]) : '';
  const app = (id) => ({ ...G.apps.get(id), app: id });
  if (steamId && G.bySteam.has(steamId)) return app(G.bySteam.get(steamId));
  const base = p.split('/').pop();
  let best = null, bestLen = 0, tie = false;
  for (const c of G.byExe.get(base) || []) {
    if (!(c.exact ? base === c.name : p === c.name || p.endsWith('/' + c.name))) continue;
    if (c.name.length > bestLen) { best = c.id; bestLen = c.name.length; tie = false; }
    else if (c.name.length === bestLen && c.id !== best) tie = true;
  }
  // одно имя у нескольких игр (hl2.exe у всех на движке Source) — не угадываем
  if (best && !tie) return app(best);
  const steamName = String(proc?.steam?.[1] || '').trim().slice(0, 100);
  if (steamId && steamName && !/redistributable|steamworks|soundtrack|dedicated server|\bsdk\b/i.test(steamName))
    return { name: steamName, icon: '', steam: steamId, app: '' };
  return null;
}
// Из всех запущенных игр показываем ту, что запустили последней
function pickGame(procs) {
  if (!Array.isArray(procs)) return null;
  let game = null;
  for (const proc of procs.slice(0, 400)) {
    const m = matchProc(proc);
    if (!m) continue;
    const start = Math.min(Number(proc.t) || Date.now(), Date.now());
    if (!game || start > game.start)
      game = { name: m.name, app: m.app, steam: m.steam, start, icon: m.icon ? 'd' + m.app : m.steam ? 's' + m.steam : '' };
  }
  return game;
}
// несколько устройств — игра с того, где она запущена позже
function gameOf(id) {
  let game = null;
  for (const ws of sockets.get(id) || []) if (ws.game && (!game || ws.game.start > game.start)) game = ws.game;
  return game;
}
const shownGame = new Map(); // id -> что последним разослали контактам
function announceGame(id) {
  const u = q.userById.get(id);
  if (!u) return;
  const game = statusOf(u) === 'offline' ? null : gameOf(id);
  const key = game ? `${game.app}|${game.steam}|${game.name}|${game.start}` : '';
  if ((shownGame.get(id) || '') === key) return;
  shownGame.set(id, key);
  for (const f of contactIds(id)) push(f, { type: 'game', userId: id, game });
  push(id, { type: 'game', userId: id, game: gameOf(id) });
}
// Иконка игры из CDN Discord (d<id>) или шапка из Steam (s<appid>): скачиваем один раз и отдаём сами —
// CDN Discord в России без VPN не открывается
const iconLoads = new Map();
async function gameIcon(key) {
  const file = path.join(GAME_ICONS_DIR, key + '.img');
  if (fs.existsSync(file)) return file;
  const id = key.slice(1);
  const a = key[0] === 'd' ? G.apps.get(id) : null;
  const src = key[0] === 's' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`
    : a?.icon ? `https://cdn.discordapp.com/app-icons/${id}/${a.icon}.png?size=128` : '';
  if (!src) return null;
  if (!iconLoads.has(key)) iconLoads.set(key, (async () => {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(15e3) });
      if (!r.ok || !/^image\/(png|jpeg)$/.test(r.headers.get('content-type') || '')) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) return null;
      fs.writeFileSync(file, buf);
      return file;
    } catch { return null; } finally { setTimeout(() => iconLoads.delete(key), 60e3); }
  })());
  return iconLoads.get(key);
}

function setImage(id, kind, name) {
  const old = q.userById.get(id)?.[kind];
  q.setImage[kind].run(name, id);
  if (old) fs.rmSync(path.join(AVATARS_DIR, old), { force: true });
}
function isFriend(a, b) {
  const r = q.rel.get(a, b, b, a);
  return r && r.status === 'accepted';
}
// вложение видят участники группы или двое из личной беседы
const canSee = (me, f) => !!f && (f.grp ? isMember(f.grp, me.id) : f.sender === me.id || f.recipient === me.id);

// --- избранные гифки и звуки звуковой панели ---
const gifPath = (hash) => path.join(GIFS_DIR, hash + '.gif');
const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
// from — путь к файлу-вложению или сама гифка (Buffer)
function addFavGif(uid, hash, w, h, size, from) {
  if (q.gif.get(uid, hash)) return;
  if (q.gifCount.get(uid).n >= MAX_GIFS) throw [400, `В избранном не больше ${MAX_GIFS} гифок`];
  if (!fs.existsSync(gifPath(hash))) {
    if (Buffer.isBuffer(from)) fs.writeFileSync(gifPath(hash), from);
    else fs.copyFileSync(from, gifPath(hash));
  }
  q.addGif.run(uid, hash, w, h, size, Date.now());
}
function soundFields(b) {
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!name) throw [400, 'Дайте звуку название'];
  const emoji = String(b.emoji ?? '').trim().slice(0, 16);
  const vol = Math.max(0, Math.min(1, Number(b.vol)));
  return { name, emoji, vol: Number.isFinite(vol) ? vol : 1 };
}
function mySound(me, id) {
  const s = q.sound.get(Number(id));
  if (!s || s.uid !== me.id) throw [404, 'Звук не найден'];
  return s;
}
const ytInfo = new Map(); // id видео -> название и канал (oEmbed YouTube)
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
    members: q.members.all(g.id).map(pub),
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
    const u = pub(r);
    if (r.rel === 'accepted') out.friends.push(u);
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
    const id = Number(q.addUser.run(username, hashPass(b.password), Date.now()).lastInsertRowid);
    q.seen.run(Date.now(), id);
    return { token: sign(id), user: selfView(q.userById.get(id)) };
  },
  'POST /api/login': async (_u, b) => {
    const u = q.userByName.get(String(b.username || '').trim());
    if (!u || !checkPass(String(b.password || ''), u.pass)) throw [401, 'Неверный ник или пароль'];
    // причину видит только тот, кто знает пароль; старые клиенты показывают текст ошибки как есть
    if (u.banned) throw [403, 'Аккаунт заблокирован' + (u.ban_reason ? ': ' + u.ban_reason : '')];
    q.seen.run(Date.now(), u.id);
    return { token: sign(u.id, u.tokver), user: selfView(u) };
  },
  'GET /api/me': async (me) => selfView(me),
  // Свой профиль: присланные поля меняем, остальные не трогаем; avatar/banner: null — убрать картинку
  'POST /api/me/profile': async (me, b) => {
    const str = (k, max, oneLine = true) => {
      if (b[k] === undefined) return me[k] || '';
      const s = String(b[k] ?? '');
      return (oneLine ? s.replace(/\s+/g, ' ') : s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n')).trim().slice(0, max);
    };
    const bcolor = b.bcolor === undefined ? me.bcolor || '' : String(b.bcolor || '');
    if (bcolor && !/^#[0-9a-f]{6}$/i.test(bcolor)) throw [400, 'Неверный цвет баннера'];
    q.setProfile.run(str('display', 32), str('bio', 190, false), str('pronouns', 40), str('custom', 128), bcolor, me.id);
    for (const kind of ['avatar', 'banner']) if (b[kind] === null) setImage(me.id, kind, null);
    pushProfile(me.id);
    return selfView(q.userById.get(me.id));
  },
  // Смена пароля: проверяем старый пароль, хэшируем новый и повышаем tokver (завершает старые сессии на других устройствах)
  'POST /api/me/password': async (me, b) => {
    const oldPass = String(b.oldPassword || '');
    const newPass = String(b.newPassword || '');
    if (newPass.length < 6) throw [400, 'Новый пароль минимум 6 символов'];
    const row = q.userPassById.get(me.id);
    if (!row || !checkPass(oldPass, row.pass)) throw [403, 'Неверный текущий пароль'];
    if (oldPass === newPass) throw [400, 'Новый пароль должен отличаться от старого'];
    q.setPass.run(hashPass(newPass), me.id);
    const newTokver = (row.tokver || 0) + 1;
    return { ok: true, token: sign(me.id, newTokver) };
  },
  'POST /api/me/status': async (me, b) => {
    if (!STATUSES.includes(b.status)) throw [400, 'Неизвестный статус'];
    q.setStatus.run(b.status, me.id);
    announce(me.id);
    announceGame(me.id);
    const view = selfView(q.userById.get(me.id));
    push(me.id, { type: 'me', user: view });
    return view;
  },
  // Профиль другого человека: друга, участника общей группы или того, с кем есть заявка в друзья
  'GET /api/users/profile': async (me, _b, url) => {
    const id = Number(url.searchParams.get('id'));
    const u = q.userById.get(id);
    if (!u || !(id === me.id || q.rel.get(me.id, id, id, me.id) || q.coMembers.all(me.id).some((r) => r.uid === id)))
      throw [404, 'Пользователь не найден'];
    if (id === me.id) return { ...selfView(u), mutualFriends: [], mutualGroups: [] };
    const mine = new Set(friendIds(me.id));
    return {
      ...pub(u),
      mutualFriends: friendIds(id).filter((f) => mine.has(f)),
      mutualGroups: q.groupsOf.all(me.id).filter((g) => isMember(g.id, id)).map((g) => g.id),
    };
  },
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
  // Удалить своё сообщение у всех (вместе с вложением)
  'POST /api/messages/delete': async (me, b) => {
    const m = q.msg.get(Number(b.id));
    if (!m || m.sender !== me.id || m.kind) throw [404, 'Сообщение не найдено'];
    if (m.grp && !isMember(m.grp, me.id)) throw [404, 'Сообщение не найдено'];
    q.delMsg.run(m.id);
    if (m.file) {
      q.delFile.run(m.file);
      fs.rmSync(path.join(FILES_DIR, m.file), { force: true });
    }
    const event = { type: 'message_deleted', id: m.id, grp: m.grp || null, peer: m.grp ? null : m.recipient, sender: m.sender };
    if (m.grp) pushGroup(m.grp, event);
    else { push(m.recipient, event); push(me.id, event); }
    return { ok: true };
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
  'GET /api/gifs': async (me) => q.gifs.all(me.id),
  // ★ на гифке в чате: в избранное
  'POST /api/gifs/fav': async (me, b) => {
    const f = q.file.get(String(b.file || ''));
    if (!canSee(me, f) || f.type !== 'image/gif') throw [404, 'Гифка не найдена'];
    if (f.size > MAX_GIF) throw [413, `Гифка больше ${MAX_GIF / 1048576} МБ`];
    const src = path.join(FILES_DIR, f.id);
    const hash = f.gif || await sha256File(src);
    if (!f.gif) q.setFileGif.run(hash, f.id);
    addFavGif(me.id, hash, f.w, f.h, f.size, src);
    return { hash, gifs: q.gifs.all(me.id) };
  },
  'POST /api/gifs/unfav': async (me, b) => {
    const hash = String(b.hash || '');
    q.delGif.run(me.id, hash);
    // отправленные гифки — отдельные вложения, им удаление из избранного не мешает
    if (/^[0-9a-f]{64}$/.test(hash) && !q.gifUsers.get(hash).n) fs.rmSync(gifPath(hash), { force: true });
    return q.gifs.all(me.id);
  },
  // Гифка из избранного в беседу: новое вложение — жёсткая ссылка на тот же файл
  'POST /api/gifs/send': async (me, b) => {
    const g = q.gif.get(me.id, String(b.hash || ''));
    if (!g) throw [404, 'Гифка не найдена'];
    const gid = Number(b.group) || 0;
    const peer = gid ? 0 : Number(b.peer);
    fileTarget(me, gid, peer);
    const id = crypto.randomBytes(16).toString('hex');
    try { fs.linkSync(gifPath(g.hash), path.join(FILES_DIR, id)); } catch { fs.copyFileSync(gifPath(g.hash), path.join(FILES_DIR, id)); }
    return postFile(me, peer, gid, { id, name: g.hash.slice(0, 12) + '.gif', size: g.size, type: 'image/gif', w: g.w, h: g.h, gif: g.hash });
  },
  // Звуки свои и тех, с кем звоним (?users=1,2,3): только свои и контактов
  'GET /api/sounds': async (me, _b, url) => {
    const ok = new Set([me.id, ...contactIds(me.id)]);
    const ids = String(url.searchParams.get('users') || me.id).split(',').map(Number).filter((id) => ok.has(id));
    return [...new Set(ids)].flatMap((id) => q.soundsOf.all(id));
  },
  'POST /api/sounds/edit': async (me, b) => {
    const s = mySound(me, b.id);
    const f = soundFields(b);
    q.editSound.run(f.name, f.emoji, f.vol, s.id);
    return q.soundsOf.all(me.id);
  },
  'POST /api/sounds/delete': async (me, b) => {
    const s = mySound(me, b.id);
    q.delSound.run(s.id);
    fs.rmSync(path.join(SOUNDS_DIR, s.file), { force: true });
    return q.soundsOf.all(me.id);
  },
  // Название видео для очереди совместного просмотра
  'GET /api/yt/info': async (_me, _b, url) => {
    const v = String(url.searchParams.get('v') || '');
    if (!/^[\w-]{11}$/.test(v)) throw [400, 'Неверная ссылка на видео'];
    if (!ytInfo.has(v)) {
      const watch = 'https://www.youtube.com/watch?v=' + v;
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(watch), { signal: AbortSignal.timeout(6000) }).catch(() => null);
      if (!r?.ok) return { title: '', author: '' }; // не кэшируем: могло не ответить
      const j = await r.json().catch(() => ({}));
      if (ytInfo.size >= 2000) ytInfo.delete(ytInfo.keys().next().value);
      ytInfo.set(v, { title: String(j.title || '').slice(0, 200), author: String(j.author_name || '').slice(0, 100) });
    }
    return ytInfo.get(v);
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

function fileTarget(me, gid, peer) {
  if (gid && !isMember(gid, me.id)) throw [404, 'Группа не найдена'];
  if (!gid && !isFriend(me.id, peer)) throw [403, 'Отправлять файлы можно только друзьям'];
}
// Сообщение с уже сохранённым на диске вложением meta — в личку или в группу
function postFile(me, peer, gid, meta) {
  q.addFile.run(meta.id, me.id, peer, meta.name, meta.size, meta.type, meta.w, meta.h, Date.now(), gid || null, meta.gif ?? null);
  if (gid) return groupMsg(gid, me, '', null, meta);
  const created = Date.now();
  const { lastInsertRowid } = q.addMsg.run(me.id, peer, '', created, meta.id, null, null);
  const msg = { id: Number(lastInsertRowid), sender: me.id, recipient: peer, text: '', created, file: meta };
  push(peer, { type: 'message', msg });
  push(me.id, { type: 'message', msg });
  return msg;
}

// Отправка файла в личку (?peer=) или в группу (?group=): тело запроса — сам файл, имя и размеры
// превью — в параметрах. Пишем потоком сразу на диск, в память файл целиком не попадает.
async function uploadFile(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const gid = Number(url.searchParams.get('group')) || 0;
  const peer = gid ? 0 : Number(url.searchParams.get('peer'));
  try { fileTarget(me, gid, peer); } catch (e) { return send(e[0], { error: e[1] }); }
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
  const hash = type === 'image/gif' ? crypto.createHash('sha256') : null; // для избранных гифок
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) {
        got += chunk.length;
        if (got > size) throw new Error('too long');
        hash?.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(file + '.part'));
    if (got !== size) throw new Error('incomplete');
    fs.renameSync(file + '.part', file);
  } catch {
    fs.rmSync(file + '.part', { force: true });
    return res.headersSent || res.destroyed || send(400, { error: 'Загрузка прервалась' });
  }
  const meta = { id, name, size, type, w: dim('w'), h: dim('h'), gif: hash?.digest('hex') ?? null };
  // из группы могли выйти, пока файл грузился
  if (gid && !isMember(gid, me.id)) { fs.rmSync(file, { force: true }); return send(404, { error: 'Группа не найдена' }); }
  send(200, postFile(me, peer, gid, meta));
}

// Небольшой файл целиком в память (картинки профиля, гифки, звуки); null — загрузка прервалась
async function readBody(req, size) {
  const chunks = [];
  let got = 0;
  try {
    for await (const chunk of req) {
      got += chunk.length;
      if (got > size) return null;
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  return got === size ? Buffer.concat(chunks) : null;
}
const sizeError = (req, max, what) => {
  const size = Number(req.headers['content-length']);
  if (!size) return [400, 'Пустой файл'];
  if (size > max) return [413, `${what} больше ${max / 1048576} МБ`];
  return null;
};

// Аватарка или баннер (?kind=banner): тело — картинка, уже обрезанная и уменьшенная клиентом
const MAGIC = { png: /^\x89PNG/, jpg: /^\xff\xd8\xff/, gif: /^GIF8/, webp: /^RIFF....WEBP/s };
async function uploadImage(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const kind = url.searchParams.get('kind') === 'banner' ? 'banner' : 'avatar';
  const ext = IMAGE_EXT[String(req.headers['content-type'] || '').toLowerCase()];
  if (!ext) return send(415, { error: 'Нужна картинка PNG, JPEG, WebP или GIF' });
  const bad = sizeError(req, MAX_IMAGE, 'Картинка');
  if (bad) return send(bad[0], { error: bad[1] });
  const data = await readBody(req, Number(req.headers['content-length']));
  if (!data) return res.destroyed || send(400, { error: 'Загрузка прервалась' });
  if (!MAGIC[ext].test(data.subarray(0, 12).toString('latin1'))) return send(415, { error: 'Файл не похож на картинку' });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(AVATARS_DIR, name), data);
  setImage(me.id, kind, name);
  pushProfile(me.id);
  send(200, selfView(q.userById.get(me.id)));
}

// Своя гифка с компьютера — сразу в избранное (?w=&h= — размер для превью)
async function uploadGif(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const bad = sizeError(req, MAX_GIF, 'Гифка');
  if (bad) return send(bad[0], { error: bad[1] });
  const data = await readBody(req, Number(req.headers['content-length']));
  if (!data) return res.destroyed || send(400, { error: 'Загрузка прервалась' });
  if (!MAGIC.gif.test(data.subarray(0, 4).toString('latin1'))) return send(415, { error: 'Это не GIF' });
  const dim = (k) => { const v = Math.round(Number(url.searchParams.get(k))); return v > 0 && v < 1e5 ? v : null; };
  try {
    addFavGif(me.id, crypto.createHash('sha256').update(data).digest('hex'), dim('w'), dim('h'), data.length, data);
  } catch (e) {
    return Array.isArray(e) ? send(e[0], { error: e[1] }) : send(500, { error: 'Ошибка сервера' });
  }
  send(200, q.gifs.all(me.id));
}

// Новый звук звуковой панели (?name=&emoji=&vol=): тело — уже обрезанный клиентом звук
const SOUND_MAGIC = { wav: /^RIFF....WAVE/s, mp3: /^(ID3|\xff[\xe0-\xff])/, ogg: /^OggS/ };
async function uploadSound(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const ext = SOUND_EXT[String(req.headers['content-type'] || '').toLowerCase()];
  if (!ext) return send(415, { error: 'Нужен звук WAV, MP3 или OGG' });
  const bad = sizeError(req, MAX_SOUND, 'Звук');
  if (bad) return send(bad[0], { error: bad[1] });
  let f;
  try {
    f = soundFields(Object.fromEntries(url.searchParams));
    if (q.soundCount.get(me.id).n >= MAX_SOUNDS) throw [400, `Своих звуков не больше ${MAX_SOUNDS}`];
  } catch (e) { return send(e[0], { error: e[1] }); }
  const data = await readBody(req, Number(req.headers['content-length']));
  if (!data) return res.destroyed || send(400, { error: 'Загрузка прервалась' });
  if (!SOUND_MAGIC[ext].test(data.subarray(0, 12).toString('latin1'))) return send(415, { error: 'Файл не похож на звук' });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(SOUNDS_DIR, name), data);
  q.addSound.run(me.id, f.name, f.emoji, name, f.vol, Date.now());
  send(200, q.soundsOf.all(me.id));
}

// Аватарки, баннеры, избранные гифки и звуки видны всем, как в Discord: имена файлов не угадать,
// а содержимое по одному имени никогда не меняется
const PUBLIC_TYPES = { ...IMAGE_EXT, 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };
function sendImage(res, dir, name, send) {
  const file = path.join(dir, name);
  let st;
  try { st = fs.statSync(file); } catch { return send(404, { error: 'Нет файла' }); }
  const type = Object.keys(PUBLIC_TYPES).find((t) => name.endsWith('.' + PUBLIC_TYPES[t]));
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// Картинки, видео и звук показываем прямо в чате, остальное — только скачивание
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg)|audio\/[\w.+-]+)$/;

// Скачивание вложения (с Range — чтобы видео можно было перематывать). Токен можно передать
// в ?token=, т.к. <img>/<video> не умеют слать заголовок Authorization. ?dl — всегда как файл.
function downloadFile(req, res, url, id, send) {
  const me = verify(bearer(req) || url.searchParams.get('token'));
  if (!me) return send(401, { error: 'Нужно войти' });
  const f = q.file.get(id);
  if (!canSee(me, f)) return send(404, { error: 'Файл не найден' });
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
  if (url.pathname === '/api/me/image' && req.method === 'POST') return uploadImage(req, res, url, send);
  if (url.pathname === '/api/gifs/upload' && req.method === 'POST') return uploadGif(req, res, url, send);
  if (url.pathname === '/api/sounds/upload' && req.method === 'POST') return uploadSound(req, res, url, send);
  const gicon = /^\/api\/games\/icon\/([ds]\d{1,20})$/.exec(url.pathname)?.[1];
  if (gicon && req.method === 'GET') {
    const file = await gameIcon(gicon);
    if (!file) return send(404, { error: 'Нет иконки' });
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': buf[0] === 0x89 ? 'image/png' : 'image/jpeg', 'Content-Length': buf.length,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=604800',
    });
    return res.end(buf);
  }
  const image = /^\/api\/avatars\/([0-9a-f]{32}\.(png|jpg|webp|gif))$/.exec(url.pathname)?.[1];
  if (image && req.method === 'GET') return sendImage(res, AVATARS_DIR, image, send);
  const gif = /^\/api\/gifs\/([0-9a-f]{64}\.gif)$/.exec(url.pathname)?.[1];
  if (gif && req.method === 'GET') return sendImage(res, GIFS_DIR, gif, send);
  const sound = /^\/api\/sounds\/([0-9a-f]{32}\.(wav|mp3|ogg))$/.exec(url.pathname)?.[1];
  if (sound && req.method === 'GET') return sendImage(res, SOUNDS_DIR, sound, send);
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
  if (!sockets.has(me.id)) sockets.set(me.id, new Set());
  sockets.get(me.id).add(ws);
  ws.uid = me.id;
  q.seen.run(Date.now(), me.id);
  announce(me.id);

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // Сигналинг звонков: invite / accept / decline / end пересылаем другу
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // клиент давно не трогали (или снова трогают) — «в сети» сам становится «неактивен»
    if (m.type === 'afk') {
      ws.afk = !!m.afk;
      return announce(me.id);
    }
    // запущенные программы (null — показ игр выключен в настройках)
    if (m.type === 'procs') {
      ws.game = pickGame(m.procs);
      return announceGame(me.id);
    }
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
    if (set && set.size === 0) sockets.delete(me.id);
    q.seen.run(Date.now(), me.id);
    announce(me.id); // закрылось «активное» окно — остальные могут быть неактивны
    announceGame(me.id);
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// --- админка ---
// Отдельный HTTP-сервер только на 127.0.0.1, Caddy туда не проксирует: заходить через
// ssh -L 8081:127.0.0.1:8081 и вводить ADMIN_TOKEN. Без токена админка не запускается
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8081);
const ADMIN_HTML = new URL('./admin.html', import.meta.url);
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 5;
const MAX_RINGTONE = 5 * 1024 * 1024;

const qa = {
  users: db.prepare('SELECT id, username, display, avatar, created, seen, banned FROM users ORDER BY id DESC'),
  user: db.prepare('SELECT id, username, display, avatar, banner, status, created, seen, banned, ban_reason, tokver FROM users WHERE id = ?'),
  counts: db.prepare(`SELECT
    (SELECT COUNT(*) FROM friends WHERE (a = $id OR b = $id) AND status = 'accepted') AS friends,
    (SELECT COUNT(*) FROM friends WHERE (a = $id OR b = $id) AND status = 'pending') AS requests,
    (SELECT COUNT(*) FROM group_members WHERE uid = $id) AS grps,
    (SELECT COUNT(*) FROM messages WHERE sender = $id AND kind IS NULL) AS messages,
    (SELECT COUNT(*) FROM files WHERE sender = $id) AS files,
    (SELECT COALESCE(SUM(size), 0) FROM files WHERE sender = $id) AS filesSize,
    (SELECT COUNT(*) FROM gifs WHERE uid = $id) AS gifs,
    (SELECT COUNT(*) FROM sounds WHERE uid = $id) AS sounds`),
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM users WHERE banned IS NOT NULL) AS banned,
    (SELECT COUNT(*) FROM messages WHERE kind IS NULL) AS messages, (SELECT COUNT(*) FROM groups) AS grps,
    (SELECT COUNT(*) FROM files) AS files, (SELECT COALESCE(SUM(size), 0) FROM files) AS filesSize`),
  // бан заодно отзывает токены: после разбана старые сессии не оживают
  ban: db.prepare('UPDATE users SET banned = ?, ban_reason = ?, tokver = tokver + 1 WHERE id = ?'),
  unban: db.prepare('UPDATE users SET banned = NULL, ban_reason = NULL WHERE id = ?'),
  bumpTok: db.prepare('UPDATE users SET tokver = tokver + 1 WHERE id = ?'),
  setPass: db.prepare('UPDATE users SET pass = ?, tokver = tokver + 1 WHERE id = ?'),
  // всё, что удаляется вместе с аккаунтом: личные переписки в обе стороны, его сообщения и вложения в группах
  userGroupMsgs: db.prepare('SELECT id, grp FROM messages WHERE sender = ? AND grp IS NOT NULL'),
  delUserMsgs: db.prepare('DELETE FROM messages WHERE sender = ? OR (grp IS NULL AND recipient = ?)'),
  userFiles: db.prepare('SELECT id FROM files WHERE sender = ? OR (grp IS NULL AND recipient = ?)'),
  delUserFiles: db.prepare('DELETE FROM files WHERE sender = ? OR (grp IS NULL AND recipient = ?)'),
  userGifs: db.prepare('SELECT hash FROM gifs WHERE uid = ?'),
  delUserGifs: db.prepare('DELETE FROM gifs WHERE uid = ?'),
  delUserSounds: db.prepare('DELETE FROM sounds WHERE uid = ?'),
  delUserRels: db.prepare('DELETE FROM friends WHERE a = ? OR b = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  addAudit: db.prepare('INSERT INTO audit (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)'),
  audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300'),
};

const auditLog = (req, action, target = null, details = null) =>
  qa.addAudit.run(Date.now(), 'admin@' + (req.socket.remoteAddress || '?'), action, target, details && JSON.stringify(details));

function adminUser(id) {
  const u = qa.user.get(Number(id));
  if (!u) throw [404, 'Пользователь не найден'];
  return u;
}
// Карточка без текста переписки: только счётчики, друзья и группы
function userCard(u) {
  return {
    ...u, online: online(u.id), sessions: sockets.get(u.id)?.size || 0,
    counts: qa.counts.get({ id: u.id }),
    friends: q.relsOf.all(u.id, u.id, u.id).map((r) => ({
      id: r.id, username: r.username, rel: r.rel === 'accepted' ? 'friend' : r.a === u.id ? 'out' : 'in',
    })),
    groups: q.groupsOf.all(u.id).map((g) => ({ id: g.id, name: g.name, owner: g.owner === u.id, members: memberIds(g.id).length })),
  };
}

// Закрыть все соединения человека и выкинуть его из звонков. Клиент переподключится,
// получит отказ, на первом же запросе — 401 и экран входа
function dropSessions(uid) {
  for (const ws of sockets.get(uid) || []) ws.close(4001, 'unauthorized');
  for (const g of q.groupsOf.all(uid)) lk.removeParticipant(groupRoom(g.id), String(uid)).catch(() => {});
  for (const f of friendIds(uid)) lk.removeParticipant(roomFor(uid, f), String(uid)).catch(() => {});
}

function deleteUser(u) {
  const rels = q.relsOf.all(u.id, u.id, u.id).map((r) => r.id);
  const groups = q.groupsOf.all(u.id);
  const groupMsgs = qa.userGroupMsgs.all(u.id);
  const files = qa.userFiles.all(u.id, u.id).map((f) => f.id);
  const gifs = qa.userGifs.all(u.id).map((g) => g.hash);
  const sounds = q.soundsOf.all(u.id).map((s) => s.file);
  dropSessions(u.id);
  db.exec('BEGIN');
  try {
    qa.delUserMsgs.run(u.id, u.id);
    qa.delUserFiles.run(u.id, u.id);
    qa.delUserGifs.run(u.id);
    qa.delUserSounds.run(u.id);
    qa.delUserRels.run(u.id, u.id);
    for (const g of groups) {
      q.delMember.run(g.id, u.id);
      const rest = memberIds(g.id);
      if (rest.length) {
        if (g.owner === u.id) q.setOwner.run(rest[0], g.id); // владение — следующему, как при выходе
        continue;
      }
      // никого не осталось — удаляем группу целиком (файлы с диска — после COMMIT)
      files.push(...q.groupFiles.all(g.id).map((f) => f.id));
      q.delGroupFiles.run(g.id);
      q.delGroupMsgs.run(g.id);
      q.delGroup.run(g.id);
    }
    qa.delUser.run(u.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const id of files) fs.rmSync(path.join(FILES_DIR, id), { force: true });
  for (const h of gifs) if (!q.gifUsers.get(h).n) fs.rmSync(gifPath(h), { force: true });
  for (const f of sounds) fs.rmSync(path.join(SOUNDS_DIR, f), { force: true });
  for (const f of [u.avatar, u.banner]) if (f) fs.rmSync(path.join(AVATARS_DIR, f), { force: true });
  shown.delete(u.id);
  for (const id of rels) push(id, { type: 'friends' });
  const members = new Map(groups.map((g) => [g.id, memberIds(g.id)]));
  for (const m of groupMsgs)
    for (const id of members.get(m.grp) || []) push(id, { type: 'message_deleted', id: m.id, grp: m.grp, peer: null, sender: u.id });
  for (const g of groups) pushGroup(g.id, { type: 'groups' });
}

// Копия базы через VACUUM INTO (cp пропустил бы WAL); храним последние KEEP_BACKUPS
function backup(tag) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').slice(0, 18);
  const file = path.join(BACKUPS_DIR, `startrack-${stamp}-${tag}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const all = fs.readdirSync(BACKUPS_DIR).filter((f) => /^startrack-.+\.db$/.test(f)).sort();
  for (const f of all.slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(BACKUPS_DIR, f), { force: true });
  return path.basename(file);
}
const backupsList = () => {
  try {
    return fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.db')).sort().reverse()
      .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUPS_DIR, f)).size }));
  } catch { return []; }
};

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
  }
  return n;
}
function ringtoneInfo() {
  try {
    const st = fs.statSync(RINGTONE);
    return { size: st.size, updated: Math.floor(st.mtimeMs) };
  } catch { return null; }
}
// Временный пароль без похожих символов (l/1, O/0)
const PASS_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tempPass = () => Array.from({ length: 12 }, () => PASS_CHARS[crypto.randomInt(PASS_CHARS.length)]).join('');

const adminRoutes = {
  'GET /api/stats': () => {
    const disk = fs.statfsSync(DATA_DIR);
    const parts = fs.readdirSync(DATA_DIR, { withFileTypes: true }).map((e) => {
      const p = path.join(DATA_DIR, e.name);
      return { name: e.name + (e.isDirectory() ? '/' : ''), size: e.isDirectory() ? dirSize(p) : fs.statSync(p).size };
    }).sort((a, b) => b.size - a.size);
    return {
      ...qa.stats.get(), online: sockets.size, connections: wss.clients.size, uptime: Math.round(process.uptime()),
      data: parts.reduce((s, p) => s + p.size, 0), parts,
      disk: { free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize },
      ringtone: ringtoneInfo(), backups: backupsList(),
    };
  },
  // Поиск по нику и отображаемому имени (без учёта регистра, в том числе для кириллицы)
  'GET /api/users': (_b, url) => {
    const s = String(url.searchParams.get('q') || '').trim().toLowerCase();
    return qa.users.all()
      .filter((u) => !s || u.username.toLowerCase().includes(s) || (u.display || '').toLowerCase().includes(s) || String(u.id) === s)
      .slice(0, 200).map((u) => ({ ...u, online: online(u.id) }));
  },
  'GET /api/user': (_b, url) => userCard(adminUser(url.searchParams.get('id'))),
  // Новый пароль показываем один раз; старые сессии разлогиниваются
  'POST /api/user/reset': (b, _url, req) => {
    const u = adminUser(b.id);
    const password = tempPass();
    qa.setPass.run(hashPass(password), u.id);
    dropSessions(u.id);
    auditLog(req, 'reset_password', u.id, { username: u.username });
    return { password, user: userCard(adminUser(u.id)) };
  },
  // Свой пароль вместо случайного (те же правила, что при регистрации); старые сессии разлогиниваются
  'POST /api/user/password': (b, _url, req) => {
    const u = adminUser(b.id);
    const password = String(b.password ?? '');
    if (password.length < 6) throw [400, 'Пароль минимум 6 символов'];
    if (password.length > 128) throw [400, 'Пароль не длиннее 128 символов'];
    qa.setPass.run(hashPass(password), u.id);
    if (!b.keep) dropSessions(u.id);
    auditLog(req, 'set_password', u.id, { username: u.username, keep_sessions: !!b.keep });
    return userCard(adminUser(u.id));
  },
  'POST /api/user/ban': (b, _url, req) => {
    const u = adminUser(b.id);
    const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    qa.ban.run(Date.now(), reason || null, u.id);
    dropSessions(u.id);
    auditLog(req, 'ban', u.id, { username: u.username, reason });
    return userCard(adminUser(u.id));
  },
  'POST /api/user/unban': (b, _url, req) => {
    const u = adminUser(b.id);
    qa.unban.run(u.id);
    auditLog(req, 'unban', u.id, { username: u.username });
    return userCard(adminUser(u.id));
  },
  'POST /api/user/logout': (b, _url, req) => {
    const u = adminUser(b.id);
    qa.bumpTok.run(u.id);
    dropSessions(u.id);
    auditLog(req, 'logout', u.id, { username: u.username });
    return userCard(adminUser(u.id));
  },
  // Удаление — только с ником в подтверждении и после бэкапа базы
  'POST /api/user/delete': (b, _url, req) => {
    const u = adminUser(b.id);
    if (b.confirm !== u.username) throw [400, 'Для подтверждения введите ник точно'];
    const file = backup('delete-' + u.id);
    deleteUser(u);
    auditLog(req, 'delete', u.id, { username: u.username, backup: file });
    return { ok: true, backup: file };
  },
  'POST /api/backup': (_b, _url, req) => {
    const file = backup('manual');
    auditLog(req, 'backup', null, { file });
    return { file, backups: backupsList() };
  },
  'GET /api/audit': () => qa.audit.all().map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null })),
};

// Новая мелодия звонка: тело — mp3. Клиенты увидят новую версию по времени изменения файла
async function uploadRingtone(req, res, send) {
  const bad = sizeError(req, MAX_RINGTONE, 'Мелодия');
  if (bad) return send(bad[0], { error: bad[1] });
  const data = await readBody(req, Number(req.headers['content-length']));
  if (!data) return res.destroyed || send(400, { error: 'Загрузка прервалась' });
  if (!SOUND_MAGIC.mp3.test(data.subarray(0, 4).toString('latin1'))) return send(415, { error: 'Нужен файл MP3' });
  fs.writeFileSync(RINGTONE + '.part', data);
  fs.renameSync(RINGTONE + '.part', RINGTONE);
  auditLog(req, 'ringtone', null, { size: data.length });
  send(200, ringtoneInfo());
}

// сравнение без утечки длины и содержимого по времени ответа
const sameSecret = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

const admin = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // только localhost по имени: защита от DNS rebinding
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'Forbidden' });
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:",
    });
    return fs.createReadStream(ADMIN_HTML).on('error', () => res.destroy()).pipe(res);
  }
  const image = /^\/avatars\/([0-9a-f]{32}\.(png|jpg|webp|gif))$/.exec(url.pathname)?.[1];
  if (image && req.method === 'GET') return sendImage(res, AVATARS_DIR, image, send);
  if (!sameSecret(bearer(req), ADMIN_TOKEN)) return send(401, { error: 'Неверный токен админки' });
  if (url.pathname === '/api/ringtone' && req.method === 'POST') return uploadRingtone(req, res, send);
  if (url.pathname === '/api/ringtone' && req.method === 'GET') {
    let st;
    try { st = fs.statSync(RINGTONE); } catch { return send(404, { error: 'Мелодия не задана' }); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    return fs.createReadStream(RINGTONE).pipe(res);
  }
  const handler = adminRoutes[`${req.method} ${url.pathname}`];
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
    send(200, await handler(body, url, req));
  } catch (e) {
    if (Array.isArray(e)) return send(e[0], { error: e[1] });
    console.error(e);
    send(500, { error: 'Ошибка сервера: ' + (e?.message || e) });
  }
});
// занятый порт не должен ронять основной API
admin.on('error', (e) => console.error('Админка не запустилась:', e.message));

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Startrack API on :${PORT}, LiveKit ${LK_URL}`));
if (ADMIN_TOKEN.length >= 16) admin.listen(ADMIN_PORT, '127.0.0.1', () => console.log(`Админка на 127.0.0.1:${ADMIN_PORT}`));
else console.log('ADMIN_TOKEN не задан или короче 16 символов — админка выключена');
