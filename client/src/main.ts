import './style.css';
import {
  AudioPresets, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteTrack, type TrackPublication,
} from 'livekit-client';

type User = { id: number; username: string; online?: boolean };
type Msg = { id: number; sender: number; recipient: number; text: string; created: number };

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  server: store.get('server') || 'https://185-218-0-111.sslip.io',
  token: store.get('token') || '',
  me: null as User | null,
  friends: { friends: [] as User[], incoming: [] as User[], outgoing: [] as User[] },
  peer: null as User | null,
  msgs: new Map<number, Msg[]>(),
  unread: new Set<number>(),
  ws: null as WebSocket | null,
};

function toast(text: string) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Сетевая ошибка (сервер недоступен), а не ответ сервера с ошибкой
class NetError extends Error {}

// retries: сколько раз повторить при сетевой ошибке (через VPN соединение иногда «залипает»)
async function api(path: string, body?: unknown, timeoutMs = 15000, retries = 0): Promise<any> {
  let r: Response;
  try {
    r = await fetch(S.server + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (retries > 0) return api(path, body, timeoutMs, retries - 1);
    const timeout = (err as Error).name === 'TimeoutError';
    throw new NetError(timeout
      ? `Сервер не ответил за ${timeoutMs / 1000} секунд.`
      : `Не удалось связаться с сервером (${(err as Error).message}).`);
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) logout();
  if (!r.ok) throw new Error(data.error || 'Ошибка сервера: HTTP ' + r.status);
  return data;
}

const NET_HINT = 'Проверьте интернет. Если включён VPN, прокси или антивирус с веб-защитой — попробуйте отключить его или добавить Startrack в исключения.';

// ---------- auth ----------
let authMode: 'login' | 'register' = 'login';

function renderAuth(error = '') {
  const reg = authMode === 'register';
  $('#root').innerHTML = `
    <form class="auth" novalidate>
      <h1>Startrack</h1>
      <div class="tabs">
        <button type="button" data-mode="login" class="${reg ? '' : 'active'}">Вход</button>
        <button type="button" data-mode="register" class="${reg ? 'active' : ''}">Регистрация</button>
      </div>
      <p class="hint">${reg ? 'Новый аккаунт: придумайте ник и пароль.' : 'Уже есть аккаунт? Введите ник и пароль.'}</p>
      <label>Ник<input name="username" autocomplete="username" maxlength="32" placeholder="${reg ? '2–32 символа: буквы, цифры, _ . -' : ''}"></label>
      <label>Пароль<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'не меньше 6 символов' : ''}"></label>
      ${reg ? '<label>Повторите пароль<input name="password2" type="password" autocomplete="new-password"></label>' : ''}
      <button class="submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      <div class="status"></div>
      <div class="err">${esc(error)}</div>
      <details><summary>Подключение <span class="srv"><span class="dot"></span><span class="srvtxt">проверяю…</span></span></summary>
        <label>Адрес сервера<input name="server" value="${esc(S.server)}"></label>
        <button type="button" class="ghost sm" id="chk">Проверить связь</button>
      </details>
    </form>`;
  const f = $<HTMLFormElement>('.auth');
  const status = (text: string) => ($('.status', f).innerHTML = text ? `<span class="spin"></span>${esc(text)}` : '');
  const fail = (text: string) => { status(''); $('.err', f).textContent = text; };
  const serverInput = () => String(new FormData(f).get('server')).trim().replace(/\/+$/, '');

  f.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => (b.onclick = () => {
    authMode = b.dataset.mode as typeof authMode;
    renderAuth();
  }));
  $('#chk', f).onclick = () => { S.server = serverInput(); store.set('server', S.server); checkServer(); };
  checkServer();

  f.onsubmit = async (e) => {
    e.preventDefault();
    $('.err', f).textContent = '';
    const fd = new FormData(f);
    const username = String(fd.get('username')).trim();
    const password = String(fd.get('password'));
    if (!username || !password) return fail('Введите ник и пароль.');
    if (reg) {
      if (!/^[\p{L}\d_.-]{2,32}$/u.test(username)) return fail('Ник: от 2 до 32 символов — буквы, цифры, «_», «.», «-». Без пробелов.');
      if (password.length < 6) return fail('Пароль должен быть не короче 6 символов.');
      if (password !== fd.get('password2')) return fail('Пароли не совпадают.');
    }
    S.server = serverInput();
    store.set('server', S.server);
    const btn = $<HTMLButtonElement>('.submit', f);
    btn.disabled = true;
    status(reg ? 'Создаю аккаунт…' : 'Вхожу…');
    try {
      const r = await api('/api/' + authMode, { username, password });
      status('Готово, загружаю…');
      S.token = r.token;
      store.set('token', r.token);
      start(r.user);
    } catch (err) {
      btn.disabled = false;
      fail(err instanceof NetError ? `${err.message} Адрес: ${S.server}. ${NET_HINT}` : (err as Error).message);
    }
  };
}

// Индикатор доступности сервера на экране входа
async function checkServer() {
  const box = document.querySelector('.auth .srv');
  if (!box) return;
  box.className = 'srv';
  box.querySelector('.srvtxt')!.textContent = 'проверяю…';
  const t0 = performance.now();
  let ok = false;
  try { ok = (await api('/health', undefined, 8000)).ok === true; } catch {}
  if (!document.body.contains(box)) return;
  box.className = 'srv ' + (ok ? 'ok' : 'bad');
  box.querySelector('.srvtxt')!.textContent = ok
    ? `сервер доступен, ${Math.round(performance.now() - t0)} мс`
    : 'сервер недоступен';
  if (!ok) $('.auth').querySelector('details')?.setAttribute('open', '');
}

function logout() {
  hangup(true);
  S.token = '';
  S.me = null;
  store.set('token', '');
  const ws = S.ws;
  S.ws = null;
  ws?.close();
  renderAuth();
}

// ---------- main ----------
function start(me: User) {
  S.me = me;
  $('#root').innerHTML = `
    <div class="app">
      <aside class="side">
        <div class="brand">Startrack</div>
        <form id="addf"><input placeholder="Добавить друга по нику"><button>+</button></form>
        <div id="flist"></div>
        <div class="me"><span class="dot on"></span>${esc(me.username)}<button id="ringset" class="ghost sm" title="Мелодия звонка">🔔</button><button id="logout" class="ghost sm">Выйти</button></div>
      </aside>
      <main class="main">
        <section id="call" hidden></section>
        <section id="chat"></section>
      </main>
    </div>`;
  $('#logout').onclick = logout;
  $('#ringset').onclick = ringSettings;
  $<HTMLFormElement>('#addf').onsubmit = async (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('#addf input');
    try {
      S.friends = await api('/api/friends/request', { username: inp.value.trim() });
      inp.value = '';
      toast('Заявка отправлена');
      renderFriends();
    } catch (err) { toast((err as Error).message); }
  };
  $('#flist').onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.act === 'open') return openChat(S.friends.friends.find((f) => f.id === id)!);
    S.friends = await api('/api/friends/' + b.dataset.act, { userId: id });
    renderFriends();
  };
  renderFriends();
  renderChat();
  connectWs();
}

function ringSettings() {
  if (C.incoming) return;
  const name = store.get('ringName');
  $('#modal').innerHTML = `
    <div class="incoming ringset">
      <b>Мелодия звонка</b>
      <div class="muted">${name ? 'Сейчас: ' + esc(name) : 'Сейчас: стандартная'}</div>
      <div class="row">
        <button id="rpick">Выбрать файл…</button>
        <button id="rplay" class="ghost" title="Прослушать">▶</button>
        <button id="rdef" class="ghost">Стандартная</button>
        <button id="rclose" class="ghost">✕</button>
      </div>
      <input type="file" id="rfile" accept="audio/*" hidden>
    </div>`;
  const close = () => { ringtone(false); $('#modal').innerHTML = ''; };
  let playing = false;
  $('#rclose').onclick = close;
  $('#rplay').onclick = () => { playing = !playing; ringtone(playing, true); $('#rplay').textContent = playing ? '⏹' : '▶'; };
  $('#rpick').onclick = () => $('#rfile').click();
  $<HTMLInputElement>('#rfile').onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 30e6) return toast('Файл больше 30 МБ');
    await idb('readwrite', (s) => s.put(file, 'ringtone'));
    store.set('ringName', file.name);
    toast('Мелодия звонка сохранена');
    ringtone(false);
    ringSettings();
  };
  $('#rdef').onclick = async () => {
    await idb('readwrite', (s) => s.delete('ringtone'));
    store.set('ringName', '');
    toast('Стандартная мелодия');
    ringtone(false);
    ringSettings();
  };
}

async function loadFriends() {
  S.friends = await api('/api/friends');
  renderFriends();
}

function renderFriends() {
  const { friends, incoming, outgoing } = S.friends;
  const item = (u: User, extra: string, act = '') => `
    <div class="fr ${S.peer?.id === u.id ? 'sel' : ''}" ${act}>
      <span class="dot ${u.online ? 'on' : ''}"></span><span class="nm">${esc(u.username)}</span>
      ${S.unread.has(u.id) ? '<span class="badge"></span>' : ''}${extra}
    </div>`;
  $('#flist').innerHTML =
    (incoming.length ? `<h4>Заявки</h4>` + incoming.map((u) => item(u,
      `<button class="sm" data-act="accept" data-id="${u.id}">✓</button><button class="sm ghost" data-act="remove" data-id="${u.id}">✕</button>`)).join('') : '') +
    (outgoing.length ? `<h4>Исходящие</h4>` + outgoing.map((u) => item(u,
      `<button class="sm ghost" data-act="remove" data-id="${u.id}">✕</button>`)).join('') : '') +
    `<h4>Друзья — ${friends.length}</h4>` +
    (friends.map((u) => item(u, '', `data-act="open" data-id="${u.id}"`)).join('') || '<div class="muted">Пока никого</div>');
}

async function openChat(u: User) {
  S.peer = u;
  S.unread.delete(u.id);
  renderFriends();
  renderChat();
  if (!S.msgs.has(u.id)) {
    S.msgs.set(u.id, await api('/api/dm/messages?peer=' + u.id));
    if (S.peer?.id === u.id) renderMessages();
  }
}

function renderChat() {
  const p = S.peer;
  if (!p) {
    $('#chat').innerHTML = '<div class="empty">Выбери друга слева, чтобы написать или позвонить</div>';
    return;
  }
  $('#chat').innerHTML = `
    <header><span class="nm">@${esc(p.username)}</span><button id="callbtn">📞 Позвонить</button></header>
    <div id="msgs"></div>
    <form id="send"><input placeholder="Написать @${esc(p.username)}" maxlength="4000" autofocus></form>`;
  $('#callbtn').onclick = () => startCall(p);
  $<HTMLFormElement>('#send').onsubmit = async (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('#send input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    try { await api('/api/dm/messages', { peer: p.id, text }); } catch (err) { toast((err as Error).message); }
  };
  renderMessages();
}

function renderMessages() {
  const box = $('#msgs');
  if (!box || !S.peer) return;
  const list = S.msgs.get(S.peer.id) || [];
  box.innerHTML = list.map((m) => {
    const who = m.sender === S.me!.id ? S.me!.username : S.peer!.username;
    const time = new Date(m.created).toLocaleString('ru', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `<div class="msg"><b>${esc(who)}</b><time>${time}</time><p>${esc(m.text)}</p></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

// ---------- realtime ----------
function connectWs() {
  const ws = new WebSocket(S.server.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(S.token));
  S.ws = ws;
  ws.onopen = () => loadFriends().catch(() => {});
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => { if (S.ws === ws) setTimeout(() => S.ws === ws && connectWs(), 2000); };
}
const wsSend = (m: object) => S.ws?.readyState === WebSocket.OPEN && S.ws.send(JSON.stringify(m));

function onEvent(ev: any) {
  switch (ev.type) {
    case 'message': {
      const m: Msg = ev.msg;
      const other = m.sender === S.me!.id ? m.recipient : m.sender;
      if (S.msgs.has(other)) S.msgs.get(other)!.push(m);
      if (S.peer?.id === other) renderMessages();
      else { S.unread.add(other); renderFriends(); }
      break;
    }
    case 'friends': loadFriends(); break;
    case 'presence': {
      const f = S.friends.friends.find((u) => u.id === ev.userId);
      if (f) { f.online = ev.online; renderFriends(); }
      break;
    }
    case 'call_invite': onIncoming(ev.from); break;
    case 'call_accept': if (C.peer?.id === ev.from.id) setCallState('incall'); break;
    case 'call_decline':
      if (C.peer?.id === ev.from.id && C.state === 'calling') { toast(`${ev.from.username} отклонил звонок`); hangup(false); }
      break;
    case 'call_end':
      if (C.incoming?.id === ev.from.id) closeIncoming();
      if (C.peer?.id === ev.from.id) hangup(false);
      break;
    // ответили/отклонили на другом нашем устройстве
    case 'call_accept_self': case 'call_decline_self': case 'call_end_self':
      if (C.incoming?.id === ev.peer) closeIncoming();
      break;
  }
}

// ---------- calls ----------
const QUALITY = {
  '720p30': { w: 1280, h: 720, fps: 30, br: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, br: 4_500_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, br: 8_000_000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, br: 12_000_000 },
} as const;
type QKey = keyof typeof QUALITY;

const C = {
  room: null as Room | null,
  peer: null as User | null,
  state: 'idle' as 'idle' | 'calling' | 'incall',
  incoming: null as User | null,
  deaf: false,
  ringTimer: 0,
  quality: (store.get('quality') as QKey) || '1080p60',
  hint: (store.get('hint') as 'motion' | 'detail') || 'motion',
  codec: (store.get('codec') as 'h264' | 'vp9' | 'av1') || 'h264',
  ns: store.get('ns') !== '0',
  // TCP-режим (медиа через TURN/TLS на 443): вручную в настройках, сам при VPN или если UDP рвётся
  relay: store.get('relay') === '1',
  relayAuto: false, // включили сами в этой сессии из-за обрывов
  relayBroken: false, // TURN/TLS в этой сети не подключается — больше не пробуем
  vpn: null as string | null, // адаптер VPN, через который идёт трафик к серверу
  switching: false,
  gen: 0, // номер звонка: после сброса незавершённые подключения закрываются
  rejoins: 0,
  peerGone: 0,
  net: '', // статус связи в шапке звонка
};

type Carry = { mic: boolean; tracks: { track: MediaStreamTrack; source: Track.Source }[] };

function setRelay(on: boolean) {
  C.relay = on;
  store.set('relay', on ? '1' : '0');
}

function setNet(text: string) {
  C.net = text;
  const el = document.getElementById('netst');
  if (el) el.textContent = text;
}

// Какой адаптер повезёт трафик к серверу; если это туннель VPN — сразу звоним через TCP
const VPN_RE = /\b(tun|tap)\b|wintun|wireguard|xray|v2ray|happ|clash|mihomo|sing-?box|hiddify|nekobox|outline|amnezia|openvpn|vpn|tunnel/i;
async function detectVpn(serverUrl: string): Promise<string | null> {
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return null;
  const host = new URL(serverUrl).hostname;
  const m = host.match(/^(\d+)-(\d+)-(\d+)-(\d+)\.sslip\.io$/);
  const ip = m ? m.slice(1).join('.') : /^[\d.]+$/.test(host) ? host : null;
  if (!ip) return null;
  try {
    const adapter: string | null = await invoke('route_adapter', { ip });
    return adapter && VPN_RE.test(adapter) ? adapter.split(' | ')[0] : null;
  } catch {
    return null;
  }
}

const screenPublishOpts = () => {
  const q = QUALITY[C.quality];
  return {
    videoCodec: C.codec,
    simulcast: false,
    screenShareEncoding: { maxBitrate: q.br, maxFramerate: q.fps, priority: 'high' as const },
    degradationPreference: (C.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution') as RTCDegradationPreference,
    audioPreset: AudioPresets.musicHighQualityStereo,
    dtx: false,
    red: false,
  };
};

// Переподключение звонка без потери микрофона и демонстрации экрана (те же треки публикуем заново)
async function reconnect(peer: User, toRelay: boolean) {
  if (C.switching || !C.room) return;
  C.switching = true;
  if (toRelay && !C.relayAuto && !C.relay) {
    C.relayAuto = true;
    toast('Связь нестабильна (VPN?) — перехожу в TCP-режим');
  }
  setNet(toRelay ? 'переподключаюсь в TCP-режиме…' : 'переподключаюсь…');
  const old = C.room;
  C.room = null;
  const lp = old.localParticipant;
  const carry: Carry = { mic: lp.isMicrophoneEnabled, tracks: [] };
  for (const pub of lp.trackPublications.values())
    if ((pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) && pub.track)
      carry.tracks.push({ track: pub.track.mediaStreamTrack, source: pub.source });
  lp.getTrackPublication(Track.Source.Microphone)?.track?.stop();
  await old.disconnect(false).catch(() => {});
  $('#audio').innerHTML = '';
  document.getElementById('stage')?.replaceChildren();
  try {
    await joinRoom(peer, carry);
  } catch (err) {
    toast('Не удалось переподключиться: ' + (err as Error).message);
    hangup(true);
  } finally {
    C.switching = false;
  }
}

// mode: 'auto' — по ситуации (VPN/обрывы -> TURN/TLS), 'all' — все пути (UDP, TCP 7881, TURN), запасной вариант
async function joinRoom(peer: User, carry?: Carry, mode: 'auto' | 'all' = 'auto') {
  const gen = C.gen;
  const { url, token } = await api('/api/call/token', { peer: peer.id }, 7000, 2);
  if (gen !== C.gen) throw new Error('звонок отменён');
  // VPN смотрим по адресу медиасервера: туда идут звук и видео
  if (!carry && mode === 'auto') { C.vpn = await detectVpn(url); C.rejoins = 0; }
  const relay = mode === 'auto' && !C.relayBroken && (C.relay || C.relayAuto || !!C.vpn);
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns },
    // RED + Opus 48 кбит/с: устойчивый к потерям чистый голос
    publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.music },
  });
  C.room = room;
  let reconnTimer = 0;
  let reconnCount = 0;
  let joined = false; // до успешного connect обрывы обрабатывает catch ниже, а не события
  const mine = () => C.room === room && joined;
  room
    .on(RoomEvent.TrackSubscribed, () => { syncAudio(room); renderStage(); })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach(); syncAudio(room); renderStage(); })
    .on(RoomEvent.Reconnected, () => syncAudio(room))
    .on(RoomEvent.LocalTrackPublished, renderStage)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => { pub.track?.detach().forEach((e) => e.remove()); renderStage(); })
    .on(RoomEvent.TrackMuted, renderPeople)
    .on(RoomEvent.TrackUnmuted, renderPeople)
    .on(RoomEvent.ActiveSpeakersChanged, renderPeople)
    .on(RoomEvent.ParticipantConnected, () => {
      clearTimeout(C.peerGone);
      setNet('');
      setCallState('incall');
    })
    // Собеседник пропал — ждём, вдруг переподключается. Явное «Завершить» придёт через call_end
    .on(RoomEvent.ParticipantDisconnected, () => {
      syncAudio(room);
      renderStage();
      if (room.remoteParticipants.size > 0 || C.state !== 'incall') return;
      setNet(`${peer.username} переподключается…`);
      clearTimeout(C.peerGone);
      C.peerGone = window.setTimeout(() => { if (mine() && room.remoteParticipants.size === 0) { toast('Собеседник отключился'); hangup(true); } }, 20000);
    })
    .on(RoomEvent.Reconnecting, () => {
      if (!mine()) return;
      setNet('связь прервалась, восстанавливаю…');
      if (relay || C.relayBroken) return;
      // UDP через VPN часто «моргает»: если сам не восстановился за 4 с или рвётся повторно — в TCP
      if (++reconnCount >= 2) return reconnect(peer, true);
      reconnTimer = window.setTimeout(() => mine() && reconnect(peer, true), 4000);
    })
    .on(RoomEvent.Reconnected, () => { clearTimeout(reconnTimer); if (mine()) setNet(''); })
    .on(RoomEvent.Disconnected, () => {
      clearTimeout(reconnTimer);
      if (!mine()) return;
      if (++C.rejoins > 3) { toast('Связь потеряна'); return hangup(true); }
      reconnect(peer, true);
    });
  try {
    await room.connect(url, token, {
      rtcConfig: relay ? { iceTransportPolicy: 'relay' } : undefined,
      websocketTimeout: 6000,
      maxRetries: 3,
    });
    if (gen !== C.gen || C.room !== room) { room.disconnect(); throw new Error('звонок отменён'); }
    joined = true;
  } catch (err) {
    if (gen !== C.gen || C.room !== room) { room.disconnect(); throw err; }
    C.room = null;
    await room.disconnect(false).catch(() => {});
    // Не подключились: TURN/TLS -> пробуем все пути; UDP -> пробуем TURN/TLS
    if (relay) { C.relayBroken = true; return joinRoom(peer, carry, 'all'); }
    if (mode === 'all' || C.relayAuto) throw err;
    C.relayAuto = true;
    return joinRoom(peer, carry);
  }
  if (room.remoteParticipants.size > 0) { C.state = 'incall'; setNet(''); }
  for (const t of carry?.tracks || [])
    if (t.track.readyState === 'live')
      await room.localParticipant.publishTrack(t.track, { source: t.source, ...screenPublishOpts() }).catch(() => {});
  try {
    await room.localParticipant.setMicrophoneEnabled(carry ? carry.mic : true);
  } catch {
    toast('Нет доступа к микрофону');
  }
  renderCall();
}

async function startCall(peer: User) {
  if (C.room) return toast('Ты уже в звонке');
  C.peer = peer;
  setCallState('calling');
  try {
    await joinRoom(peer);
    wsSend({ type: 'call_invite', to: peer.id });
    C.ringTimer = window.setTimeout(() => { if (C.state === 'calling') { toast('Нет ответа'); hangup(true); } }, 30000);
  } catch (err) {
    toast('Не удалось начать звонок: ' + (err as Error).message);
    hangup(false);
  }
}

function onIncoming(from: User) {
  if (C.room) return wsSend({ type: 'call_decline', to: from.id });
  C.incoming = from;
  $('#modal').innerHTML = `
    <div class="incoming">
      <div class="ring">📞</div><b>${esc(from.username)}</b> звонит
      <div class="row"><button id="acc">Принять</button><button id="dec" class="danger">Отклонить</button></div>
    </div>`;
  ringtone(true);
  $('#acc').onclick = async () => {
    closeIncoming();
    C.peer = S.friends.friends.find((f) => f.id === from.id) || from;
    setCallState('incall');
    try {
      await joinRoom(C.peer);
      wsSend({ type: 'call_accept', to: from.id });
    } catch (err) {
      toast('Не удалось подключиться: ' + (err as Error).message);
      hangup(true);
    }
  };
  $('#dec').onclick = () => { closeIncoming(); wsSend({ type: 'call_decline', to: from.id }); };
}

function closeIncoming() {
  C.incoming = null;
  $('#modal').innerHTML = '';
  ringtone(false);
}

// Своя мелодия звонка хранится в IndexedDB этого ПК (файл в несколько МБ не влезает в localStorage)
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('startrack', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    };
  });
}

let ringCtx: AudioContext | null = null;
let ringAudio: HTMLAudioElement | null = null;
async function ringtone(on: boolean, preview = false) {
  ringCtx?.close();
  ringCtx = null;
  if (ringAudio) {
    ringAudio.pause();
    URL.revokeObjectURL(ringAudio.src);
    ringAudio = null;
  }
  if (!on) return;
  const blob = await idb<Blob>('readonly', (s) => s.get('ringtone')).catch(() => undefined);
  if (!preview && !C.incoming) return; // звонок уже приняли/сбросили, пока читали файл
  if (blob) {
    const a = (ringAudio = new Audio(URL.createObjectURL(blob)));
    a.loop = true;
    a.volume = 0.7;
    return a.play().catch(() => beep());
  }
  beep();
}

function beep() {
  const ctx = (ringCtx = new AudioContext());
  for (let i = 0; i < 15; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime + i);
    g.gain.setValueAtTime(0, ctx.currentTime + i + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + i);
    o.stop(ctx.currentTime + i + 0.4);
  }
}

function setCallState(s: typeof C.state) {
  C.state = s;
  if (s === 'incall') clearTimeout(C.ringTimer);
  renderCall();
}

function hangup(notify: boolean) {
  C.gen++;
  clearTimeout(C.ringTimer);
  clearTimeout(C.peerGone);
  C.net = '';
  if (notify && C.peer && C.state !== 'idle') wsSend({ type: 'call_end', to: C.peer.id });
  const room = C.room;
  C.room = null;
  C.peer = null;
  C.state = 'idle';
  room?.disconnect();
  $('#audio').innerHTML = '';
  renderCall();
}

async function toggleScreen() {
  const lp = C.room!.localParticipant;
  if (lp.isScreenShareEnabled) return lp.setScreenShareEnabled(false);
  const q = QUALITY[C.quality];
  try {
    await lp.setScreenShareEnabled(true, {
      audio: true, // звук системы / вкладки
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      contentHint: C.hint,
      resolution: { width: q.w, height: q.h, frameRate: q.fps },
    }, screenPublishOpts());
  } catch (err) {
    if ((err as Error).name !== 'NotAllowedError') toast('Демонстрация не запустилась: ' + (err as Error).message);
  }
  renderCall();
}

function renderCall() {
  const box = $('#call');
  if (!box) return;
  if (C.state === 'idle') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const lp = C.room?.localParticipant;
  const mic = lp?.isMicrophoneEnabled ?? false;
  const scr = lp?.isScreenShareEnabled ?? false;
  const opt = (o: Record<string, string>, v: string) =>
    Object.entries(o).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('');
  box.innerHTML = `
    <div class="ctitle">${C.state === 'calling' ? 'Вызов… ' : 'Звонок: '}<b>${esc(C.peer?.username || '')}</b>
      ${C.relay || C.relayAuto || C.vpn ? `<span class="tag" title="${C.vpn ? 'VPN: ' + esc(C.vpn) : 'Нестабильный UDP'}">TCP-режим</span>` : ''}
      <span id="netst">${esc(C.net)}</span></div>
    <div id="stage"></div>
    <div id="people"></div>
    <div class="controls">
      <button id="bmic" class="${mic ? '' : 'off'}" title="Микрофон">${mic ? '🎤' : '🔇'}</button>
      <button id="bdeaf" class="${C.deaf ? 'off' : ''}" title="Звук">${C.deaf ? '🔈✕' : '🎧'}</button>
      <button id="bscr" class="${scr ? 'on' : ''}">${scr ? '⏹ Остановить показ' : '🖥 Демонстрация'}</button>
      <button id="bset" class="ghost">⚙</button>
      <button id="bend" class="danger">Завершить</button>
    </div>
    <div id="settings" hidden>
      <label>Качество <select id="sq">${opt({ '720p30': '720p 30fps', '1080p30': '1080p 30fps', '1080p60': '1080p 60fps', '1440p60': '1440p 60fps' }, C.quality)}</select></label>
      <label>Режим <select id="sh">${opt({ motion: 'Плавность (игры, видео)', detail: 'Чёткость (текст, код)' }, C.hint)}</select></label>
      <label>Кодек <select id="sc">${opt({ h264: 'H.264 (аппаратный)', vp9: 'VP9', av1: 'AV1' }, C.codec)}</select></label>
      <label>Микрофон <select id="smic"></select></label>
      <label>Вывод <select id="sout"></select></label>
      <label><input type="checkbox" id="sns" ${C.ns ? 'checked' : ''}> Шумоподавление и эхо</label>
      <label title="Медиа через TLS-туннель: стабильно за VPN, чуть больше задержка"><input type="checkbox" id="srelay" ${C.relay ? 'checked' : ''}> TCP-режим (для VPN)</label>
    </div>`;
  $('#bmic').onclick = async () => { await lp?.setMicrophoneEnabled(!mic); renderCall(); };
  $('#bdeaf').onclick = () => {
    C.deaf = !C.deaf;
    document.querySelectorAll<HTMLAudioElement>('#audio audio').forEach((a) => (a.muted = C.deaf));
    if (C.deaf) lp?.setMicrophoneEnabled(false).then(renderCall);
    renderCall();
  };
  $('#bscr').onclick = () => C.room && toggleScreen();
  $('#bend').onclick = () => hangup(true);
  $('#bset').onclick = () => { $('#settings').hidden = !$('#settings').hidden; if (!$('#settings').hidden) fillDevices(); };
  const bind = (id: string, key: 'quality' | 'hint' | 'codec') =>
    ($<HTMLSelectElement>(id).onchange = (e) => {
      (C as any)[key] = (e.target as HTMLSelectElement).value;
      store.set(key, (C as any)[key]);
    });
  bind('#sq', 'quality'); bind('#sh', 'hint'); bind('#sc', 'codec');
  $<HTMLInputElement>('#sns').onchange = (e) => {
    C.ns = (e.target as HTMLInputElement).checked;
    store.set('ns', C.ns ? '1' : '0');
    const t = lp?.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    t?.restartTrack({ echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns });
  };
  $<HTMLInputElement>('#srelay').onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on && C.peer) { setRelay(true); return reconnect(C.peer, true); }
    setRelay(on);
    toast('Применится со следующего звонка');
  };
  renderStage();
  renderPeople();
}

async function fillDevices() {
  const room = C.room;
  if (!room) return;
  for (const [sel, kind] of [['#smic', 'audioinput'], ['#sout', 'audiooutput']] as const) {
    const devs = await Room.getLocalDevices(kind);
    const cur = room.getActiveDevice(kind);
    const el = $<HTMLSelectElement>(sel);
    if (!el) return;
    el.innerHTML = devs.map((d) => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || d.deviceId)}</option>`).join('');
    el.onchange = () => room.switchActiveDevice(kind, el.value);
  }
}

// Видео-плитки (демонстрации экрана), элементы переиспользуем, чтобы не мигало
// Ровно один <audio> на каждый подписанный удалённый аудиотрек; после переподключений лишние убираем
function syncAudio(room: Room) {
  if (C.room !== room) return;
  const box = $('#audio');
  const live = new Map<string, RemoteTrack>();
  for (const p of room.remoteParticipants.values())
    for (const pub of p.audioTrackPublications.values())
      if (pub.track && pub.isSubscribed) live.set(pub.trackSid, pub.track as RemoteTrack);
  box.querySelectorAll<HTMLAudioElement>('audio').forEach((el) => { if (!live.has(el.dataset.tsid!)) { el.srcObject = null; el.remove(); } });
  for (const [sid, track] of live) {
    if (box.querySelector(`[data-tsid="${sid}"]`)) continue;
    const el = track.attach() as HTMLAudioElement;
    el.dataset.tsid = sid;
    el.muted = C.deaf;
    box.appendChild(el);
  }
}

function renderStage() {
  const stage = $('#stage');
  const room = C.room;
  if (!stage || !room) return;
  const pubs: [Participant, TrackPublication][] = [];
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()])
    for (const pub of p.videoTrackPublications.values()) if (pub.track) pubs.push([p, pub]);
  const keep = new Set(pubs.map(([, pub]) => pub.trackSid));
  stage.querySelectorAll<HTMLElement>('.tile').forEach((t) => { if (!keep.has(t.dataset.sid!)) t.remove(); });
  for (const [p, pub] of pubs) {
    if (stage.querySelector(`[data-sid="${pub.trackSid}"]`)) continue;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.sid = pub.trackSid;
    const v = pub.track!.attach() as HTMLVideoElement;
    v.muted = true;
    tile.append(v, Object.assign(document.createElement('span'), { textContent: p.name || p.identity }));
    tile.ondblclick = () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen());
    stage.append(tile);
  }
  stage.hidden = pubs.length === 0;
}

function renderPeople() {
  const box = $('#people');
  const room = C.room;
  if (!box || !room) return;
  box.innerHTML = [room.localParticipant, ...room.remoteParticipants.values()].map((p) =>
    `<span class="pp ${p.isSpeaking ? 'speak' : ''}">${p.isMicrophoneEnabled ? '' : '🔇 '}${esc(p.name || p.identity)}</span>`).join('');
}

// ---------- boot ----------
if (S.token) {
  $('#root').innerHTML = '<div class="auth"><h1>Startrack</h1><div class="status"><span class="spin"></span>Подключаюсь к серверу…</div></div>';
  api('/api/me').then(start).catch((err) =>
    renderAuth(err instanceof NetError ? `${err.message} ${NET_HINT}` : 'Сессия истекла, войдите заново.'));
}
else renderAuth();

// только для тестов в dev-сборке
if (import.meta.env.DEV) (window as any).__st = { C, S, reconnect };
