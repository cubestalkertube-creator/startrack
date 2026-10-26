// Startrack API: аккаунты, друзья, личные сообщения и файлы, сигналинг звонков.
// Медиа (голос/видео/демонстрация) идёт через LiveKit SFU, здесь только выдаём токены.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || './data';
const SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const LK_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

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
`);
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'file'))
  db.exec('ALTER TABLE messages ADD COLUMN file TEXT');

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
  addMsg: db.prepare('INSERT INTO messages (sender, recipient, text, created, file) VALUES (?, ?, ?, ?, ?)'),
  history: db.prepare(`
    SELECT m.*, f.name AS fname, f.size AS fsize, f.type AS ftype, f.w AS fw, f.h AS fh FROM messages m
    LEFT JOIN files f ON f.id = m.file
    WHERE ((m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ?)) AND m.id < ?
    ORDER BY m.id DESC LIMIT 50`),
  addFile: db.prepare('INSERT INTO files (id, sender, recipient, name, size, type, w, h, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  file: db.prepare('SELECT * FROM files WHERE id = ?'),
};

const msgOut = (m) => ({
  id: m.id, sender: m.sender, recipient: m.recipient, text: m.text, created: m.created,
  file: m.file ? { id: m.file, name: m.fname, size: m.fsize, type: m.ftype, w: m.fw, h: m.fh } : null,
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
function isFriend(a, b) {
  const r = q.rel.get(a, b, b, a);
  return r && r.status === 'accepted';
}
const roomFor = (a, b) => `dm_${Math.min(a, b)}_${Math.max(a, b)}`;

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
    const { lastInsertRowid } = q.addMsg.run(me.id, peer, text, created, null);
    const msg = { id: Number(lastInsertRowid), sender: me.id, recipient: peer, text, created, file: null };
    push(peer, { type: 'message', msg });
    push(me.id, { type: 'message', msg });
    return msg;
  },
  // Токен в LiveKit-комнату звонка с другом
  'POST /api/call/token': async (me, b) => {
    const peer = Number(b.peer);
    if (!isFriend(me.id, peer)) throw [403, 'Звонить можно только друзьям'];
    const room = roomFor(me.id, peer);
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity: String(me.id), name: me.username, ttl: '6h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return { url: LK_URL, token: await at.toJwt(), room };
  },
};

const bearer = (req) => (req.headers.authorization || '').replace('Bearer ', '');

// Отправка файла в личку: тело запроса — сам файл, имя и размеры превью — в параметрах.
// Пишем потоком сразу на диск, в память файл целиком не попадает.
async function uploadFile(req, res, url, send) {
  const me = verify(bearer(req));
  if (!me) return send(401, { error: 'Нужно войти' });
  const peer = Number(url.searchParams.get('peer'));
  if (!isFriend(me.id, peer)) return send(403, { error: 'Отправлять файлы можно только друзьям' });
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
  q.addFile.run(id, me.id, peer, name, size, type, meta.w, meta.h, created);
  const { lastInsertRowid } = q.addMsg.run(me.id, peer, '', created, id);
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
  if (!f || (f.sender !== me.id && f.recipient !== me.id)) return send(404, { error: 'Файл не найден' });
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
  if (!wasOnline) for (const f of friendIds(me.id)) push(f, { type: 'presence', userId: me.id, online: true });

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // Сигналинг звонков: invite / accept / decline / end пересылаем другу
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const to = Number(m.to);
    if (!['call_invite', 'call_accept', 'call_decline', 'call_end'].includes(m.type) || !isFriend(me.id, to)) return;
    push(to, { type: m.type, from: { id: me.id, username: me.username } });
    // остальные вкладки/устройства звонящего тоже должны убрать окно входящего звонка
    if (m.type !== 'call_invite') push(me.id, { type: m.type + '_self', peer: to });
  });
  ws.on('close', () => {
    const set = sockets.get(me.id);
    set?.delete(ws);
    if (set && set.size === 0) {
      sockets.delete(me.id);
      for (const f of friendIds(me.id)) push(f, { type: 'presence', userId: me.id, online: false });
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
