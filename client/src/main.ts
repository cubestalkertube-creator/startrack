import './style.css';
import {
  AudioPresets, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteTrack, type TrackPublication,
} from 'livekit-client';

type User = { id: number; username: string; online?: boolean };
type Msg = { id: number; sender: number; recipient: number; text: string; created: number };
type Tab = 'online' | 'all' | 'pending' | 'add';

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
  unread: new Map<number, number>(), // id друга -> сколько непрочитанных
  ws: null as WebSocket | null,
  tab: 'online' as Tab, // вкладка на странице «Друзья»
  filter: '', // поиск по списку бесед
  showProfile: store.get('profile') !== '0',
};

// ---------- иконки и аватарки ----------
const ICON = {
  logo: 'M12 4l2.16 5.61 6 .28-4.69 3.75 1.64 5.81L12 16.13l-5.11 3.32 1.64-5.81L3.84 9.89l6-.28z',
  friends: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  addFriend: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  hangup: 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z',
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  micOff: 'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z',
  headset: 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z',
  headsetOff: 'M12 4c3.87 0 7 3.13 7 7v2h-2.92L21 17.92V11c0-4.97-4.03-9-9-9-1.95 0-3.76.62-5.23 1.68l1.44 1.44C9.3 4.41 10.6 4 12 4zM2.27 1.72L1 3l3.33 3.32C3.49 7.68 3 9.29 3 11v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-1.17.29-2.26.79-3.22L15 17v4h3c.3 0 .59-.06.86-.14L21 23l1.27-1.27-20-20.01z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  screen: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zm-7-3.53v-2.19c-2.78 0-4.61.85-6 2.72.56-2.67 2.11-5.33 6-5.87V7l4 3.73-4 3.74z',
  account: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z',
  chat: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  signal: 'M2 22h3v-4H2zm5 0h3v-8H7zm5 0h3V10h-3zm5 0h3V4h-3z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
};
const ic = (n: keyof typeof ICON, s = 20) =>
  `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;

const AV_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#757e8a'];
const avColor = (id: number) => AV_COLORS[(Number.isFinite(id) ? id : 0) % AV_COLORS.length];
// status: undefined — без значка, true/false — в сети / не в сети
function avatar(u: User, size: number, status?: boolean) {
  const letter = ([...u.username][0] || '?').toUpperCase();
  return `<span class="av" style="--s:${size}px;--c:${avColor(u.id)}">${esc(letter)}${
    status === undefined ? '' : `<i class="st ${status ? 'on' : ''}"></i>`}</span>`;
}
const friend = (id: number) => S.friends.friends.find((f) => f.id === id);

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
    <div class="auth-bg">
    <form class="auth" novalidate>
      <div class="auth-logo">${ic('logo', 28)}Startrack</div>
      <h1>${reg ? 'Создать учётную запись' : 'С возвращением!'}</h1>
      <p class="hint">${reg ? 'Придумайте ник и пароль — и можно звать друзей.' : 'Мы так рады видеть вас снова!'}</p>
      <label><span>Ник <i>*</i></span><input name="username" autocomplete="username" maxlength="32" spellcheck="false" placeholder="${reg ? '2–32 символа: буквы, цифры, _ . -' : ''}"></label>
      <label><span>Пароль <i>*</i></span><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'не меньше 6 символов' : ''}"></label>
      ${reg ? '<label><span>Повторите пароль <i>*</i></span><input name="password2" type="password" autocomplete="new-password"></label>' : ''}
      <button class="submit">${reg ? 'Продолжить' : 'Вход'}</button>
      <div class="status"></div>
      <div class="err">${esc(error)}</div>
      <p class="alt">${reg
        ? '<a data-mode="login">Уже зарегистрированы?</a>'
        : 'Нужна учётная запись? <a data-mode="register">Зарегистрироваться</a>'}</p>
      <details><summary>Подключение <span class="srv"><span class="dot"></span><span class="srvtxt">проверяю…</span></span></summary>
        <label>Адрес сервера<input name="server" value="${esc(S.server)}" spellcheck="false"></label>
        <button type="button" class="btn sec sm" id="chk">Проверить связь</button>
      </details>
    </form>
    </div>`;
  const f = $<HTMLFormElement>('.auth');
  const status = (text: string) => ($('.status', f).innerHTML = text ? `<span class="spin"></span>${esc(text)}` : '');
  const fail = (text: string) => { status(''); $('.err', f).textContent = text; };
  const serverInput = () => String(new FormData(f).get('server')).trim().replace(/\/+$/, '');

  f.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => (b.onclick = () => {
    authMode = b.dataset.mode as typeof authMode;
    renderAuth();
  }));
  $('#chk', f).onclick = () => { S.server = serverInput(); store.set('server', S.server); checkServer(); };
  checkServer();
  $<HTMLInputElement>('input[name=username]', f).focus();

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
  closeSettings();
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
      <nav class="rail" id="rail"></nav>
      <aside class="side">
        <div class="side-top"><input id="find" placeholder="Найти беседу" spellcheck="false"></div>
        <div class="side-list">
          <div class="nav-item" id="navfr" data-act="home">${ic('friends', 24)}<span>Друзья</span><span class="pill" id="reqn" hidden></span></div>
          <div class="dm-head"><span>Личные сообщения</span><button class="ibtn sm" data-act="tab" data-tab="add" title="Добавить в друзья">${ic('plus', 16)}</button></div>
          <div id="flist"></div>
        </div>
      </aside>
      <div class="dock"><div id="voicebar" hidden></div><div class="userbar" id="userbar"></div></div>
      <main class="main">
        <header class="topbar" id="topbar"></header>
        <section id="call" hidden></section>
        <div class="body"><section id="chat"></section><aside id="profile" hidden></aside></div>
      </main>
    </div>`;
  // все кнопки интерфейса — через data-act
  $('.app').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (b) act(b);
  };
  $<HTMLInputElement>('#find').oninput = (e) => { S.filter = (e.target as HTMLInputElement).value.trim().toLowerCase(); renderDmList(); };
  renderFriends();
  renderChat();
  renderUserbar();
  connectWs();
  syncServerRingtone();
}

async function act(b: HTMLElement) {
  const id = Number(b.dataset.id);
  switch (b.dataset.act) {
    case 'home': return goHome();
    case 'tab': S.tab = b.dataset.tab as Tab; return goHome();
    case 'open': { const u = friend(id); return u && openChat(u); }
    case 'call': {
      const u = friend(id);
      if (!u) return;
      if (S.peer?.id !== u.id) openChat(u);
      return startCall(u);
    }
    case 'profile':
      S.showProfile = !S.showProfile;
      store.set('profile', S.showProfile ? '1' : '0');
      renderTop();
      return renderProfile();
    case 'accept': case 'remove':
      try {
        S.friends = await api('/api/friends/' + b.dataset.act, { userId: id });
        renderFriends();
      } catch (err) { toast((err as Error).message); }
      return;
    case 'mic': return setMute(!(C.selfMute || C.deaf));
    case 'deaf': return setDeaf(!C.deaf);
    case 'screen': return C.room && toggleScreen();
    case 'hangup': return hangup(true);
    case 'settings': return openSettings((b.dataset.tab as SetTab) || 'account');
  }
}

function goHome() {
  S.peer = null;
  renderFriends();
  renderChat();
}

// Общая мелодия звонка с сервера: качаем один раз, обновляем, если админ заменил файл
async function syncServerRingtone() {
  try {
    const { version } = await api('/api/ringtone?version=1', undefined, 8000, 1);
    if (store.get('srvRingVer') === version) return;
    const r = await fetch(S.server + '/api/ringtone', { headers: { Authorization: 'Bearer ' + S.token }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) return;
    const blob = await r.blob();
    await idb('readwrite', (s) => s.put(blob, 'serverRingtone'));
    store.set('srvRingVer', version);
  } catch (err) {
    if (err instanceof NetError) return; // нет связи — попробуем при следующем входе
    await idb('readwrite', (s) => s.delete('serverRingtone')).catch(() => {}); // админ убрал мелодию
    store.set('srvRingVer', '');
  }
}

async function loadFriends() {
  S.friends = await api('/api/friends');
  renderFriends();
}

// Всё, что зависит от списка друзей и их статусов
function renderFriends() {
  if (!S.me) return;
  const n = S.friends.incoming.length;
  const pill = $('#reqn');
  pill.hidden = !n;
  pill.textContent = String(n);
  $('#navfr').classList.toggle('sel', !S.peer);
  renderDmList();
  renderRail();
  if (!S.peer) return renderHome();
  renderTop();
  renderProfile();
}

function renderDmList() {
  const list = S.friends.friends.filter((u) => !S.filter || u.username.toLowerCase().includes(S.filter));
  $('#flist').innerHTML = list.map((u) => {
    const unread = S.unread.get(u.id) || 0;
    const inCall = C.state !== 'idle' && C.peer?.id === u.id;
    return `
      <div class="dm ${S.peer?.id === u.id ? 'sel' : ''} ${unread ? 'unread' : ''}" data-act="open" data-id="${u.id}">
        ${avatar(u, 32, !!u.online)}
        <div class="dm-n"><span>${esc(u.username)}</span>${inCall ? `<small class="incall">${ic('volume', 12)}В звонке</small>` : ''}</div>
        ${unread ? `<span class="pill">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>`;
  }).join('') || `<div class="muted">${S.filter ? 'Никого не нашлось' : 'Пока никого — добавьте друга'}</div>`;
}

// Левая колонка: «Личные сообщения», непрочитанные беседы и текущий звонок
function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  const callPeer = C.state !== 'idle' ? C.peer : null;
  const unread = [...S.unread].filter(([id]) => id !== callPeer?.id && friend(id));
  rail.innerHTML = `
    <div class="ri sel"><button class="rb home" data-act="home" title="Личные сообщения">${ic('logo', 28)}</button></div>
    ${callPeer ? `<div class="ri"><button class="rb" data-act="open" data-id="${callPeer.id}" title="${esc(callPeer.username)} — звонок">${avatar(callPeer, 48)}<span class="rb-voice">${ic('volume', 12)}</span></button></div>` : ''}
    ${unread.map(([id, n]) => `<div class="ri dot"><button class="rb" data-act="open" data-id="${id}" title="${esc(friend(id)!.username)}">${avatar(friend(id)!, 48)}<span class="rb-badge">${n > 99 ? '99+' : n}</span></button></div>`).join('')}
    <div class="rail-sep"></div>
    <div class="ri"><button class="rb add" data-act="tab" data-tab="add" title="Добавить в друзья">${ic('plus', 24)}</button></div>`;
}

function renderUserbar() {
  const box = document.getElementById('userbar');
  if (!box || !S.me) return;
  const muted = C.selfMute || C.deaf;
  const online = S.ws?.readyState === WebSocket.OPEN;
  box.innerHTML = `
    <div class="ub-me" data-act="settings" title="Настройки">${avatar(S.me, 32, online)}
      <div class="ub-n"><b>${esc(S.me.username)}</b><span>${online ? 'В сети' : 'Подключение…'}</span></div></div>
    <button class="ibtn ${muted ? 'red' : ''}" data-act="mic" title="${muted ? 'Включить микрофон' : 'Выключить микрофон'}">${ic(muted ? 'micOff' : 'mic')}</button>
    <button class="ibtn ${C.deaf ? 'red' : ''}" data-act="deaf" title="${C.deaf ? 'Включить звук' : 'Отключить звук'}">${ic(C.deaf ? 'headsetOff' : 'headset')}</button>
    <button class="ibtn" data-act="settings" title="Настройки пользователя">${ic('gear')}</button>`;
}

// ---------- страница «Друзья» ----------
function renderHome() {
  const { friends, incoming, outgoing } = S.friends;
  const tab = (t: Tab, title: string, n = 0) =>
    `<button class="tb-tab ${S.tab === t ? 'sel' : ''} ${t === 'add' ? 'add' : ''}" data-act="tab" data-tab="${t}">${title}${n ? `<span class="pill">${n}</span>` : ''}</button>`;
  $('#topbar').innerHTML = `
    <div class="tb-title">${ic('friends', 24)}<b>Друзья</b></div><span class="tb-div"></span>
    <nav class="tb-tabs">${tab('online', 'В сети')}${tab('all', 'Все')}${tab('pending', 'Ожидание', incoming.length)}${tab('add', 'Добавить в друзья')}</nav>`;
  $('#profile').hidden = true;
  const chat = $('#chat');

  if (S.tab === 'add') {
    if (document.getElementById('addf')) return; // не сбрасываем набранный ник при обновлении статусов
    chat.innerHTML = `
      <div class="fpage">
        <div class="addbox">
          <h2>Добавить в друзья</h2>
          <p>Вы можете добавить друзей по их нику в Startrack.</p>
          <form id="addf"><input placeholder="Введите ник друга" maxlength="32" spellcheck="false"><button class="btn">Отправить запрос дружбы</button></form>
          <div id="addmsg"></div>
        </div>
        <div class="home-empty">${ic('addFriend', 96)}<p>Добавьте друзей — и можно переписываться и созваниваться.</p></div>
      </div>`;
    const f = $<HTMLFormElement>('#addf');
    const inp = $<HTMLInputElement>('input', f);
    const msg = (text: string, ok: boolean) => { f.className = ok ? 'ok' : 'bad'; $('#addmsg').className = ok ? 'ok' : 'bad'; $('#addmsg').textContent = text; };
    inp.focus();
    inp.oninput = () => { f.className = ''; $('#addmsg').textContent = ''; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = inp.value.trim();
      if (!name) return;
      try {
        S.friends = await api('/api/friends/request', { username: name });
        inp.value = '';
        msg(`Запрос дружбы для ${name} отправлен.`, true);
        renderFriends();
      } catch (err) { msg((err as Error).message, false); }
    };
    return;
  }

  const row = (u: User, sub: string, btns: string, open = false) => `
    <div class="frow" ${open ? `data-act="open" data-id="${u.id}"` : ''}>
      ${avatar(u, 32, sub === 'В сети' ? true : sub === 'Не в сети' ? false : undefined)}
      <div class="fr-n"><b>${esc(u.username)}</b><span>${sub}</span></div>
      <div class="fr-btns">${btns}</div>
    </div>`;
  const rb = (a: string, id: number, icon: keyof typeof ICON, title: string, cls = '') =>
    `<button class="rbtn ${cls}" data-act="${a}" data-id="${id}" title="${title}">${ic(icon)}</button>`;
  let rows: string[];
  let title: string;
  let empty: string;
  if (S.tab === 'pending') {
    rows = [
      ...incoming.map((u) => row(u, 'Входящий запрос дружбы', rb('accept', u.id, 'check', 'Принять', 'green') + rb('remove', u.id, 'close', 'Отклонить', 'red'))),
      ...outgoing.map((u) => row(u, 'Исходящий запрос дружбы', rb('remove', u.id, 'close', 'Отменить', 'red'))),
    ];
    title = 'Ожидание';
    empty = 'Запросов дружбы нет.';
  } else {
    const list = S.tab === 'online' ? friends.filter((u) => u.online) : friends;
    rows = list.map((u) => row(u, u.online ? 'В сети' : 'Не в сети',
      rb('open', u.id, 'chat', 'Написать') + rb('call', u.id, 'phone', 'Позвонить'), true));
    title = S.tab === 'online' ? 'В сети' : 'Все друзья';
    empty = S.tab === 'online' ? 'Сейчас никого нет в сети.' : 'Друзей пока нет — добавьте кого-нибудь по нику.';
  }
  chat.innerHTML = `
    <div class="fpage">
      ${rows.length ? `<h5 class="home-h">${title} — ${rows.length}</h5>${rows.join('')}`
        : `<div class="home-empty">${ic('friends', 96)}<p>${empty}</p></div>`}
    </div>`;
}

// ---------- личные сообщения ----------
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

function renderTop() {
  const p = S.peer;
  if (!p) return;
  $('#topbar').innerHTML = `
    <div class="tb-title">${avatar(p, 24, !!friend(p.id)?.online)}<b>${esc(p.username)}</b></div>
    <div class="tb-actions">
      <button class="tb-btn" data-act="call" data-id="${p.id}" title="Начать голосовой звонок">${ic('phone', 22)}</button>
      <button class="tb-btn ${S.showProfile ? 'on' : ''}" data-act="profile" title="${S.showProfile ? 'Скрыть профиль' : 'Показать профиль'}">${ic('account', 22)}</button>
    </div>`;
}

function renderChat() {
  syncCallBox();
  const p = S.peer;
  if (!p) return renderHome();
  renderTop();
  $('#chat').innerHTML = `
    <div id="msgs"></div>
    <form id="send"><div class="composer"><textarea rows="1" maxlength="4000" placeholder="Написать @${esc(p.username)}"></textarea></div></form>`;
  const ta = $<HTMLTextAreaElement>('#send textarea');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'; };
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    grow();
    try { await api('/api/dm/messages', { peer: p.id, text }); } catch (err) { toast((err as Error).message); }
  };
  ta.oninput = grow;
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  ta.focus();
  renderMessages();
  renderProfile();
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
function stamp(t: number) {
  const hm = new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(t, Date.now())) return 'сегодня в ' + hm;
  if (sameDay(t, Date.now() - 864e5)) return 'вчера в ' + hm;
  return new Date(t).toLocaleDateString('ru') + ' ' + hm;
}

function renderMessages() {
  const box = document.getElementById('msgs');
  const p = S.peer;
  if (!box || !p) return;
  const me = S.me!;
  let html = `
    <div class="intro">${avatar(p, 80)}<h1>${esc(p.username)}</h1>
      <p>Это начало истории ваших личных сообщений с <b>@${esc(p.username)}</b>.</p></div>`;
  let prev: Msg | null = null;
  for (const m of S.msgs.get(p.id) || []) {
    if (!prev || !sameDay(prev.created, m.created))
      html += `<div class="day"><span>${new Date(m.created).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>`;
    const text = `<p>${esc(m.text)}</p>`;
    // подряд идущие сообщения одного автора в пределах 7 минут — одной группой, как в Discord
    if (prev && prev.sender === m.sender && m.created - prev.created < 7 * 60e3 && sameDay(prev.created, m.created)) {
      html += `<div class="msg cont"><time>${new Date(m.created).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time>${text}</div>`;
    } else {
      const u = m.sender === me.id ? me : p;
      html += `<div class="msg head">${avatar(u, 40)}<div class="mh"><b>${esc(u.username)}</b><time>${stamp(m.created)}</time></div>${text}</div>`;
    }
    prev = m;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

// Профиль собеседника справа (во время звонка с ним прячется, как в Discord)
function renderProfile() {
  const box = document.getElementById('profile');
  const p = S.peer;
  if (!box) return;
  box.hidden = !p || !S.showProfile || (C.state !== 'idle' && C.peer?.id === p.id);
  if (box.hidden || !p) return;
  const online = !!friend(p.id)?.online;
  box.innerHTML = `
    <div class="pf">
      <div class="pf-banner" style="--c:${avColor(p.id)}"></div>
      <div class="pf-av">${avatar(p, 80, online)}</div>
      <div class="pf-body">
        <h2>${esc(p.username)}</h2>
        <div class="pf-u">${esc(p.username)} • #${p.id}</div>
        <div class="pf-sec"><h4>Статус</h4><span class="pf-st ${online ? 'on' : ''}"><i></i>${online ? 'В сети' : 'Не в сети'}</span></div>
      </div>
      <button class="pf-btn" data-act="call" data-id="${p.id}">${ic('phone', 18)}Позвонить</button>
    </div>`;
}

// ---------- realtime ----------
function connectWs() {
  const ws = new WebSocket(S.server.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(S.token));
  S.ws = ws;
  ws.onopen = () => { renderUserbar(); loadFriends().catch(() => {}); };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    renderUserbar();
    setTimeout(() => S.ws === ws && connectWs(), 2000);
  };
}
const wsSend = (m: object) => S.ws?.readyState === WebSocket.OPEN && S.ws.send(JSON.stringify(m));

function onEvent(ev: any) {
  switch (ev.type) {
    case 'message': {
      const m: Msg = ev.msg;
      const other = m.sender === S.me!.id ? m.recipient : m.sender;
      if (S.msgs.has(other)) S.msgs.get(other)!.push(m);
      if (S.peer?.id === other) renderMessages();
      else { S.unread.set(other, (S.unread.get(other) || 0) + 1); renderFriends(); }
      break;
    }
    case 'friends': loadFriends(); break;
    case 'presence': {
      const f = friend(ev.userId);
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
  selfMute: false, // микрофон выключен кнопкой (действует и вне звонка)
  deaf: false,
  ringTimer: 0,
  quality: (store.get('quality') as QKey) || '1080p60',
  hint: (store.get('hint') as 'motion' | 'detail') || 'motion',
  codec: (store.get('codec') as 'h264' | 'vp9' | 'av1') || 'h264',
  ns: store.get('ns') !== '0',
  micId: store.get('micId') || '',
  outId: store.get('outId') || '',
  vol: Number(store.get('vol') ?? 1),
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
  renderVoicebar();
}

async function setMute(mute: boolean) {
  C.selfMute = mute;
  if (!mute && C.deaf) setDeaf(false);
  try {
    await C.room?.localParticipant.setMicrophoneEnabled(!mute);
  } catch {
    toast('Нет доступа к микрофону');
  }
  renderCall();
}

// Как в Discord: без звука — значит и без микрофона; при возврате звука микрофон как был
function setDeaf(deaf: boolean) {
  C.deaf = deaf;
  document.querySelectorAll<HTMLAudioElement>('#audio audio').forEach((a) => (a.muted = C.deaf));
  C.room?.localParticipant.setMicrophoneEnabled(!deaf && !C.selfMute).then(renderCall, () => {});
  renderCall();
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
    audioCaptureDefaults: { deviceId: C.micId || undefined, echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns },
    audioOutput: C.outId ? { deviceId: C.outId } : undefined,
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
      renderPeople();
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
    await room.localParticipant.setMicrophoneEnabled(carry ? carry.mic : !C.selfMute && !C.deaf);
  } catch {
    toast('Нет доступа к микрофону');
  }
  renderCall();
}

async function startCall(peer: User) {
  if (C.room || C.state !== 'idle') return toast('Ты уже в звонке');
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
      <div class="in-av">${avatar(from, 80)}</div>
      <b>${esc(from.username)}</b><span>Входящий звонок…</span>
      <div class="row">
        <button class="rbtn big red" id="dec" title="Отклонить">${ic('hangup', 26)}</button>
        <button class="rbtn big green" id="acc" title="Принять">${ic('phone', 24)}</button>
      </div>
    </div>`;
  ringtone(true);
  $('#acc').onclick = async () => {
    closeIncoming();
    C.peer = friend(from.id) || from;
    setCallState('incall');
    openChat(C.peer);
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
  // своя мелодия пользователя, иначе общая мелодия сервера, иначе гудки
  const blob = (await idb<Blob>('readonly', (s) => s.get('ringtone')).catch(() => undefined))
    ?? (await idb<Blob>('readonly', (s) => s.get('serverRingtone')).catch(() => undefined));
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
  if (lp.isScreenShareEnabled) return lp.setScreenShareEnabled(false).then(renderCall);
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

// Панель звонка видна только в беседе с собеседником по звонку
function syncCallBox() {
  const box = document.getElementById('call');
  if (box) box.hidden = C.state === 'idle' || !C.peer || S.peer?.id !== C.peer.id;
}

function renderCall() {
  renderUserbar();
  renderVoicebar();
  if (S.me) { renderDmList(); renderRail(); }
  renderProfile();
  const box = document.getElementById('call');
  if (!box) return;
  if (C.state === 'idle') { box.hidden = true; box.innerHTML = ''; return; }
  syncCallBox();
  const lp = C.room?.localParticipant;
  const muted = C.selfMute || C.deaf;
  const scr = lp?.isScreenShareEnabled ?? false;
  box.innerHTML = `
    <div class="call-top">
      <span class="cst">${C.state === 'calling' ? 'Вызов…' : 'Голосовой звонок'}</span>
      ${C.relay || C.relayAuto || C.vpn ? `<span class="tag" title="${C.vpn ? 'VPN: ' + esc(C.vpn) : 'Нестабильный UDP'}">TCP-режим</span>` : ''}
      <span id="netst">${esc(C.net)}</span>
    </div>
    <div id="stage"></div>
    <div id="people"></div>
    <div class="controls">
      <div class="cgroup">
        <button class="cbtn ${muted ? 'off' : ''}" data-act="mic" title="${muted ? 'Включить микрофон' : 'Выключить микрофон'}">${ic(muted ? 'micOff' : 'mic')}</button>
        <button class="cbtn ${C.deaf ? 'off' : ''}" data-act="deaf" title="${C.deaf ? 'Включить звук' : 'Отключить звук'}">${ic(C.deaf ? 'headsetOff' : 'headset')}</button>
      </div>
      <div class="cgroup">
        <button class="cbtn ${scr ? 'on' : ''}" data-act="screen" title="${scr ? 'Остановить демонстрацию' : 'Демонстрация экрана'}">${ic('screen')}</button>
        <button class="cbtn" data-act="settings" data-tab="voice" title="Настройки голоса и демонстрации">${ic('gear')}</button>
      </div>
      <button class="cbtn hang" data-act="hangup" title="Завершить звонок">${ic('hangup', 26)}</button>
    </div>`;
  renderStage();
  renderPeople();
}

// Плашка «Голос подключён» над панелью пользователя
function renderVoicebar() {
  const vb = document.getElementById('voicebar');
  if (!vb) return;
  if (C.state === 'idle' || !C.peer) { vb.hidden = true; vb.innerHTML = ''; return; }
  const scr = C.room?.localParticipant.isScreenShareEnabled ?? false;
  const st = C.state === 'calling' ? ['wait', 'Вызов…'] : C.net ? ['warn', 'Восстанавливаю связь'] : ['', 'Голос подключён'];
  vb.hidden = false;
  vb.innerHTML = `
    <div class="vb-row">
      <div class="vb-info" data-act="open" data-id="${C.peer.id}" title="Открыть беседу">
        <div class="vb-st ${st[0]}">${ic('signal', 16)}${st[1]}</div>
        <div class="vb-peer">${esc(C.peer.username)}${C.relay || C.relayAuto || C.vpn ? ' • TCP' : ''}</div>
      </div>
      <button class="ibtn" data-act="hangup" title="Отключиться">${ic('hangup')}</button>
    </div>
    <div class="vb-btns">
      <button class="vbtn ${scr ? 'on' : ''}" data-act="screen" title="${scr ? 'Остановить демонстрацию' : 'Демонстрация экрана'}">${ic('screen')}</button>
      <button class="vbtn" data-act="settings" data-tab="voice" title="Настройки голоса">${ic('gear')}</button>
    </div>`;
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
    el.volume = C.vol;
    box.appendChild(el);
  }
}

function renderStage() {
  const stage = document.getElementById('stage');
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

// Круглые аватарки участников: зелёная обводка — говорит, красный значок — без микрофона
function renderPeople() {
  const box = document.getElementById('people');
  if (!box) return;
  const room = C.room;
  const parts = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  // пока комната подключается — своя аватарка без индикаторов
  let html = !room && S.me ? `<div class="pp">${avatar(S.me, 80)}</div>` : '';
  html += parts.map((p) => {
    const u = { id: Number(p.identity), username: p.name || p.identity };
    return `<div class="pp ${p.isSpeaking ? 'speak' : ''}" title="${esc(u.username)}">${avatar(u, 80)}${
      p.isMicrophoneEnabled ? '' : `<span class="pp-mute">${ic('micOff', 14)}</span>`}</div>`;
  }).join('');
  // собеседник ещё не подключился — показываем его аватарку с пульсацией
  if (C.peer && !room?.remoteParticipants.size) html += `<div class="pp wait" title="${esc(C.peer.username)}">${avatar(C.peer, 80)}</div>`;
  box.innerHTML = html;
}

// ---------- настройки ----------
type SetTab = 'account' | 'voice' | 'sounds';
let setTab: SetTab = 'account';
let ringPreview = false;
let micTest: { stream: MediaStream; ctx: AudioContext; audio: HTMLAudioElement; raf: number } | null = null;

function openSettings(tab: SetTab) {
  if (!S.me) return;
  setTab = tab;
  const navBtn = (t: SetTab, title: string) => `<button class="sn ${setTab === t ? 'sel' : ''}" data-set="${t}">${title}</button>`;
  $('#layer').innerHTML = `
    <div class="settings">
      <nav class="set-nav"><div class="set-nav-in">
        <div class="set-me">${avatar(S.me, 40)}<div><b>${esc(S.me.username)}</b><span>Startrack</span></div></div>
        <h5>Настройки пользователя</h5>
        ${navBtn('account', 'Моя учётная запись')}
        <h5>Настройки приложения</h5>
        ${navBtn('voice', 'Голос и видео')}
        ${navBtn('sounds', 'Звуки')}
        <hr>
        <button class="sn danger" data-set="logout">Выйти ${ic('hangup', 16)}</button>
      </div></nav>
      <div class="set-body">
        <div class="set-content" id="setc"></div>
        <button class="set-close" data-set="close" title="Закрыть">${ic('close', 18)}<span>ESC</span></button>
      </div>
    </div>`;
  $('#layer').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-set]');
    if (!b) return;
    const t = b.dataset.set!;
    if (t === 'close') return closeSettings();
    if (t === 'logout') return logout();
    openSettings(t as SetTab);
  };
  renderSettingsTab();
}

function closeSettings() {
  stopMicTest();
  if (ringPreview && !C.incoming) ringtone(false);
  ringPreview = false;
  $('#layer').innerHTML = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.settings')) closeSettings();
});

function renderSettingsTab() {
  stopMicTest();
  const box = document.getElementById('setc');
  if (!box || !S.me) return;
  const me = S.me;
  if (setTab === 'account') {
    box.innerHTML = `
      <h2>Моя учётная запись</h2>
      <div class="acct">
        <div class="acct-banner" style="--c:${avColor(me.id)}"></div>
        <div class="acct-head">${avatar(me, 80, true)}<b>${esc(me.username)}</b></div>
        <div class="acct-box">
          <div class="acct-f"><h4>Имя пользователя</h4><span>${esc(me.username)}</span></div>
          <div class="acct-f"><h4>ID</h4><span>#${me.id}</span></div>
          <div class="acct-f"><h4>Сервер</h4><span>${esc(S.server)}</span></div>
        </div>
      </div>
      <hr>
      <h3>Выход</h3>
      <p class="set-hint">Выйти из учётной записи на этом компьютере.</p>
      <button class="btn red" data-set="logout">Выйти</button>`;
    return;
  }
  if (setTab === 'sounds') {
    const name = store.get('ringName');
    const server = !!store.get('srvRingVer');
    box.innerHTML = `
      <h2>Звуки</h2>
      <h3>Мелодия входящего звонка</h3>
      <div class="ring-card">
        <span class="ring-ic">${ic('bell', 22)}</span>
        <div><b>${name ? esc(name) : server ? 'Мелодия сервера' : 'Стандартная'}</b>
          <span>${name ? 'Своя мелодия — хранится на этом компьютере' : server ? 'Общая мелодия, загружена с сервера' : 'Простые гудки'}</span></div>
        <button class="rbtn" id="rplay" title="Прослушать">${ic(ringPreview ? 'stop' : 'play')}</button>
      </div>
      <div class="row">
        <button class="btn" id="rpick">Выбрать файл…</button>
        <button class="btn sec" id="rdef" ${name ? '' : 'disabled'}>По умолчанию</button>
      </div>
      <input type="file" id="rfile" accept="audio/*" hidden>`;
    $('#rplay').onclick = () => {
      if (C.incoming) return;
      ringPreview = !ringPreview;
      ringtone(ringPreview, true);
      $('#rplay').innerHTML = ic(ringPreview ? 'stop' : 'play');
    };
    $('#rpick').onclick = () => $('#rfile').click();
    $<HTMLInputElement>('#rfile').onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 30e6) return toast('Файл больше 30 МБ');
      await idb('readwrite', (s) => s.put(file, 'ringtone'));
      store.set('ringName', file.name);
      toast('Мелодия звонка сохранена');
      if (!C.incoming) ringtone(false);
      ringPreview = false;
      renderSettingsTab();
    };
    $('#rdef').onclick = async () => {
      await idb('readwrite', (s) => s.delete('ringtone'));
      store.set('ringName', '');
      toast(store.get('srvRingVer') ? 'Мелодия сервера' : 'Стандартная мелодия');
      if (!C.incoming) ringtone(false);
      ringPreview = false;
      renderSettingsTab();
    };
    return;
  }

  const opt = (o: Record<string, string>, v: string) =>
    Object.entries(o).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('');
  box.innerHTML = `
    <h2>Голос и видео</h2>
    <div class="grid2">
      <label class="fld"><span>Микрофон</span><select id="smic"><option>Загрузка…</option></select></label>
      <label class="fld"><span>Динамики</span><select id="sout"><option>Загрузка…</option></select></label>
      <div></div>
      <label class="fld"><span>Громкость звука</span><input type="range" id="svol" min="0" max="100" value="${Math.round(C.vol * 100)}"></label>
    </div>
    <div class="mictest">
      <button class="btn" id="smt">Проверка микрофона</button>
      <div class="meter" id="meter">${'<i></i>'.repeat(48)}</div>
    </div>
    <p class="set-hint">Скажите что-нибудь — мы проиграем ваш голос, чтобы вы услышали себя.</p>
    <hr>
    <h3>Профиль ввода</h3>
    <label class="radio"><input type="radio" name="prof" value="1" ${C.ns ? 'checked' : ''}><div><b>Изоляция голоса</b><span>Только ваш голос: шумоподавление, эхоподавление и автоусиление</span></div></label>
    <label class="radio"><input type="radio" name="prof" value="0" ${C.ns ? '' : 'checked'}><div><b>Студия</b><span>Чистый звук: открытый микрофон без обработки</span></div></label>
    <hr>
    <h3>Демонстрация экрана</h3>
    <div class="grid3">
      <label class="fld"><span>Качество</span><select id="sq">${opt({ '720p30': '720p 30 FPS', '1080p30': '1080p 30 FPS', '1080p60': '1080p 60 FPS', '1440p60': '1440p 60 FPS' }, C.quality)}</select></label>
      <label class="fld"><span>Режим</span><select id="sh">${opt({ motion: 'Плавность (игры, видео)', detail: 'Чёткость (текст, код)' }, C.hint)}</select></label>
      <label class="fld"><span>Кодек</span><select id="sc">${opt({ h264: 'H.264 (аппаратный)', vp9: 'VP9', av1: 'AV1' }, C.codec)}</select></label>
    </div>
    <hr>
    <h3>Соединение</h3>
    <label class="switch-row"><div><b>TCP-режим (для VPN)</b><span>Медиа через TLS-туннель: стабильно за VPN, чуть больше задержка. При VPN включается сам.</span></div>
      <input type="checkbox" class="switch" id="srelay" ${C.relay ? 'checked' : ''}></label>`;

  const bind = (id: string, key: 'quality' | 'hint' | 'codec') =>
    ($<HTMLSelectElement>(id).onchange = (e) => {
      (C as any)[key] = (e.target as HTMLSelectElement).value;
      store.set(key, (C as any)[key]);
    });
  bind('#sq', 'quality'); bind('#sh', 'hint'); bind('#sc', 'codec');
  $<HTMLInputElement>('#svol').oninput = (e) => {
    C.vol = Number((e.target as HTMLInputElement).value) / 100;
    store.set('vol', String(C.vol));
    document.querySelectorAll<HTMLAudioElement>('#audio audio').forEach((a) => (a.volume = C.vol));
    if (micTest) micTest.audio.volume = C.vol;
  };
  box.querySelectorAll<HTMLInputElement>('input[name=prof]').forEach((r) => (r.onchange = () => {
    C.ns = r.value === '1';
    store.set('ns', C.ns ? '1' : '0');
    const t = C.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    t?.restartTrack({ deviceId: C.micId || undefined, echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns });
    if (micTest) { stopMicTest(); startMicTest(); }
  }));
  $<HTMLInputElement>('#srelay').onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on && C.peer && C.room) { setRelay(true); return reconnect(C.peer, true); }
    setRelay(on);
    if (C.room) toast('Применится со следующего звонка');
  };
  $('#smt').onclick = () => (micTest ? stopMicTest() : startMicTest());
  fillDevices();
}

async function fillDevices() {
  for (const [sel, kind, key] of [['#smic', 'audioinput', 'micId'], ['#sout', 'audiooutput', 'outId']] as const) {
    let devs: MediaDeviceInfo[] = [];
    try { devs = await Room.getLocalDevices(kind); } catch {}
    const el = document.querySelector<HTMLSelectElement>(sel);
    if (!el) return;
    const cur = C.room?.getActiveDevice(kind) || C[key] || 'default';
    el.innerHTML = devs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Устройство ' + d.deviceId.slice(0, 6))}</option>`).join('')
      || '<option value="">Устройств не найдено</option>';
    el.onchange = () => {
      C[key] = el.value;
      store.set(key, el.value);
      C.room?.switchActiveDevice(kind, el.value).catch(() => toast('Не удалось переключить устройство'));
      if (micTest) { stopMicTest(); startMicTest(); }
    };
  }
}

// Проверка микрофона: индикатор громкости + воспроизведение своего голоса
async function startMicTest() {
  const btn = document.getElementById('smt');
  if (!btn) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: C.micId ? { exact: C.micId } : undefined, echoCancellation: C.ns, noiseSuppression: C.ns, autoGainControl: C.ns },
    });
  } catch {
    return toast('Нет доступа к микрофону');
  }
  if (!document.getElementById('smt')) { stream.getTracks().forEach((t) => t.stop()); return; }
  stopMicTest();
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const audio = new Audio();
  audio.srcObject = stream;
  audio.volume = C.vol;
  if (C.outId) await (audio as any).setSinkId?.(C.outId).catch(() => {});
  audio.play().catch(() => {});
  const buf = new Float32Array(an.fftSize);
  const bars = [...document.querySelectorAll<HTMLElement>('#meter i')];
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const level = Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-5) + 60) / 60)); // -60..0 дБ
    const lit = Math.round(level * bars.length);
    bars.forEach((b, i) => b.classList.toggle('lit', i < lit));
    if (micTest) micTest.raf = requestAnimationFrame(tick);
  };
  micTest = { stream, ctx, audio, raf: requestAnimationFrame(tick) };
  btn.textContent = 'Остановить проверку';
  btn.classList.add('sec');
}

function stopMicTest() {
  if (!micTest) return;
  cancelAnimationFrame(micTest.raf);
  micTest.stream.getTracks().forEach((t) => t.stop());
  micTest.ctx.close();
  micTest.audio.srcObject = null;
  micTest = null;
  document.querySelectorAll('#meter i').forEach((b) => b.classList.remove('lit'));
  const btn = document.getElementById('smt');
  if (btn) { btn.textContent = 'Проверка микрофона'; btn.classList.remove('sec'); }
}

// ---------- boot ----------
if (S.token) {
  $('#root').innerHTML = `<div class="auth-bg"><div class="boot">${ic('logo', 64)}<div class="status"><span class="spin"></span>Подключаюсь к серверу…</div></div></div>`;
  api('/api/me').then(start).catch((err) =>
    renderAuth(err instanceof NetError ? `${err.message} ${NET_HINT}` : 'Сессия истекла, войдите заново.'));
}
else renderAuth();

// только для тестов в dev-сборке
if (import.meta.env.DEV) (window as any).__st = { C, S, reconnect, onIncoming, ringPlaying: () => !!ringAudio && !ringAudio.paused };
