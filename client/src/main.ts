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

async function api(path: string, body?: unknown) {
  const r = await fetch(S.server + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) logout();
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// ---------- auth ----------
function renderAuth(error = '') {
  $('#root').innerHTML = `
    <form class="auth">
      <h1>Startrack</h1>
      <input name="username" placeholder="Ник" autocomplete="username" required>
      <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required>
      <div class="row">
        <button name="login">Войти</button>
        <button name="register" class="ghost">Регистрация</button>
      </div>
      <details><summary>Сервер</summary><input name="server" value="${esc(S.server)}"></details>
      <div class="err">${esc(error)}</div>
    </form>`;
  const f = $<HTMLFormElement>('.auth');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const mode = ((e as SubmitEvent).submitter as HTMLButtonElement)?.name || 'login';
    const fd = new FormData(f);
    S.server = String(fd.get('server')).replace(/\/+$/, '');
    store.set('server', S.server);
    try {
      const r = await api('/api/' + mode, { username: fd.get('username'), password: fd.get('password') });
      S.token = r.token;
      store.set('token', r.token);
      start(r.user);
    } catch (err) {
      $('.err').textContent = (err as Error).message;
    }
  };
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
        <div class="me"><span class="dot on"></span>${esc(me.username)}<button id="logout" class="ghost sm">Выйти</button></div>
      </aside>
      <main class="main">
        <section id="call" hidden></section>
        <section id="chat"></section>
      </main>
    </div>`;
  $('#logout').onclick = logout;
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
  // TCP-режим: медиа через TURN/TLS. Включается сам, если UDP рвётся (VPN в режиме TUN)
  relay: store.get('relay') === '1',
};

function setRelay(on: boolean) {
  C.relay = on;
  store.set('relay', on ? '1' : '0');
}

// Переподключаем текущий звонок через TURN/TLS
async function switchToRelay(peer: User) {
  setRelay(true);
  toast('Нестабильная сеть (VPN?) — переключаюсь в TCP-режим');
  const old = C.room;
  C.room = null;
  await old?.disconnect();
  $('#audio').innerHTML = '';
  try {
    await joinRoom(peer);
  } catch (err) {
    toast('Не удалось переподключиться: ' + (err as Error).message);
    hangup(true);
  }
}

async function joinRoom(peer: User) {
  const relay = C.relay;
  const { url, token } = await api('/api/call/token', { peer: peer.id });
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns },
    // RED + Opus 48 кбит/с: устойчивый к потерям чистый голос
    publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.music },
  });
  C.room = room;
  room
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.muted = C.deaf;
        $('#audio').appendChild(el);
      }
      renderStage();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach().forEach((e) => e.remove()); renderStage(); })
    .on(RoomEvent.LocalTrackPublished, renderStage)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => { pub.track?.detach().forEach((e) => e.remove()); renderStage(); })
    .on(RoomEvent.TrackMuted, renderPeople)
    .on(RoomEvent.TrackUnmuted, renderPeople)
    .on(RoomEvent.ActiveSpeakersChanged, renderPeople)
    .on(RoomEvent.ParticipantConnected, () => { setCallState('incall'); renderPeople(); })
    .on(RoomEvent.ParticipantDisconnected, () => { if (room.remoteParticipants.size === 0 && C.state === 'incall') hangup(false); })
    .on(RoomEvent.Disconnected, () => { if (C.room === room) hangup(false); })
    .on(RoomEvent.Reconnecting, () => { if (!relay && C.room === room) switchToRelay(peer); });
  try {
    await room.connect(url, token, { rtcConfig: relay ? { iceTransportPolicy: 'relay' } : undefined });
  } catch (err) {
    if (relay || C.room !== room) throw err;
    return switchToRelay(peer);
  }
  if (room.remoteParticipants.size > 0) C.state = 'incall';
  try {
    await room.localParticipant.setMicrophoneEnabled(true);
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

let ringCtx: AudioContext | null = null;
function ringtone(on: boolean) {
  ringCtx?.close();
  ringCtx = null;
  if (!on) return;
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
  clearTimeout(C.ringTimer);
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
    }, {
      videoCodec: C.codec,
      simulcast: false,
      screenShareEncoding: { maxBitrate: q.br, maxFramerate: q.fps, priority: 'high' },
      degradationPreference: C.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
    });
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
    <div class="ctitle">${C.state === 'calling' ? 'Вызов… ' : 'Звонок: '}<b>${esc(C.peer?.username || '')}</b></div>
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
    if (on && C.peer) return switchToRelay(C.peer);
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
if (S.token) api('/api/me').then(start).catch(() => renderAuth());
else renderAuth();
