import './style.css';
import {
  AudioPresets, DisconnectReason, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteTrack, type TrackPublication,
} from 'livekit-client';
import { closePicker, emojify, isJumbo, loadEmoji, noteUsed, openPicker as openEmojiPicker, replaceCodes, suggest } from './emoji';
import { SFX_GROUPS, setSfxOn, setSfxOutput, setSfxVol, sfx, sfxLoop, sfxOn, sfxVol, type SfxGroup } from './sounds';

// offline — так другие видят «невидимку»
type Status = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
// профиль как в Discord: display — отображаемое имя, custom — свой статус, avatar/banner — файлы на сервере
type User = {
  id: number; username: string; online?: boolean; status?: Status;
  display?: string; bio?: string; pronouns?: string; custom?: string; avatar?: string; banner?: string; bcolor?: string; created?: number;
};
// профиль из /api/users/profile: что у нас с этим человеком общего
type Profile = User & { mutualFriends: number[]; mutualGroups: number[] };
// вложение: w/h — размер картинки/видео (для превью без «прыжков» ленты)
type Att = { id: string; name: string; size: number; type: string; w: number | null; h: number | null };
// grp — сообщение группы; kind — системное («X добавил(а) Y»); sname — ник автора (в группе)
type Msg = {
  id: number; sender: number; recipient: number; text: string; created: number; file?: Att | null;
  grp?: number; kind?: 'create' | 'add' | 'leave' | 'kick' | 'rename' | 'call' | null; sname?: string;
};
// групповой чат: call — кто сейчас в звонке группы
type Group = { id: number; name: string; owner: number; members: User[]; call: number[] };
// файл, который сейчас загружается на сервер; conv — беседа ('u5' — друг, 'g3' — группа)
type Upload = { key: number; conv: string; name: string; size: number; sent: number; xhr: XMLHttpRequest; cancelled?: boolean };
type Tab = 'online' | 'all' | 'pending' | 'add';
declare const __APP_VERSION__: string; // версия из package.json (vite.config.ts)

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
  groups: [] as Group[],
  peer: null as User | null, // открытая личная беседа
  gid: 0, // открытая группа
  msgs: new Map<string, Msg[]>(), // ключ беседы ('u5' / 'g3') -> сообщения
  unread: new Map<string, number>(), // ключ беседы -> сколько непрочитанных
  ws: null as WebSocket | null,
  tab: 'online' as Tab, // вкладка на странице «Друзья»
  filter: '', // поиск по списку бесед
  showProfile: store.get('profile') !== '0',
  uploads: [] as Upload[],
  profiles: new Map<number, Profile>(), // загруженные профили (общие друзья и группы)
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
  download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
  attach: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
  file: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  crown: 'M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z',
  leave: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  arrowIn: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  arrowOut: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  chevron: 'M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.42 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.7 6.7a1 1 0 0 0-1.41.01z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
};
const ic = (n: keyof typeof ICON, s = 20) =>
  `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;

const AV_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#757e8a'];
const avColor = (id: number) => AV_COLORS[(Number.isFinite(id) ? id : 0) % AV_COLORS.length];
// аватарка/баннер на сервере или ещё не сохранённая картинка из редактора профиля (blob:)
const imgUrl = (name: string) => name.startsWith('blob:') ? name : `${S.server}/api/avatars/${name}`;
// как в Discord: везде отображаемое имя, ник — в профиле
const uname = (u: User) => u.display || u.username;
const ST_NAME: Record<Status, string> = { online: 'В сети', idle: 'Неактивен', dnd: 'Не беспокоить', invisible: 'Невидимый', offline: 'Не в сети' };
// Свой статус — выбранный (пока нет связи с сервером — «не в сети»), чужой — какой прислал сервер
function stOf(u: User): Status {
  if (u.id === S.me?.id) return S.ws?.readyState === WebSocket.OPEN ? S.me.status || 'online' : 'offline';
  return u.status || (u.online ? 'online' : 'offline');
}
// status — показать значок статуса в углу
function avatar(u: User, size: number, status = false) {
  const inner = u.avatar ? `<img src="${esc(imgUrl(u.avatar))}" alt="" draggable="false">` : esc(([...u.username][0] || '?').toUpperCase());
  return `<span class="av" style="--s:${size}px;--c:${avColor(u.id)}">${inner}${status ? `<i class="st ${stOf(u)}"></i>` : ''}</span>`;
}
const bannerStyle = (u: User) =>
  u.banner ? `background:${u.bcolor || avColor(u.id)} url('${esc(imgUrl(u.banner))}') center/cover` : `background:${u.bcolor || avColor(u.id)}`;
const friend = (id: number) => S.friends.friends.find((f) => f.id === id);
const group = (id: number) => S.groups.find((g) => g.id === id);
// Кого знаем по id: себя, друзей, участников групп, заявки в друзья
function userById(id: number): User | undefined {
  if (id === S.me?.id) return S.me;
  return friend(id) ?? S.groups.flatMap((g) => g.members).find((u) => u.id === id)
    ?? [...S.friends.incoming, ...S.friends.outgoing].find((u) => u.id === id);
}
// без названия группа зовётся по именам участников, как в Discord
const gname = (g: Group) =>
  g.name || g.members.filter((u) => u.id !== S.me?.id).map(uname).join(', ') || 'Пустая группа';
const gavatar = (g: Group, size: number) =>
  `<span class="av grp" style="--s:${size}px;--c:${avColor(g.id + 3)}">${ic('friends', Math.round(size * 0.6))}</span>`;

// Открытая беседа: ключ для S.msgs/S.unread, адресат для запросов и имя для подсказок
function conv() {
  if (S.peer) return { key: 'u' + S.peer.id, to: { peer: S.peer.id } as Record<string, number>, name: '@' + uname(S.peer) };
  const g = S.gid ? group(S.gid) : undefined;
  if (g) return { key: 'g' + g.id, to: { group: g.id } as Record<string, number>, name: gname(g) };
  return null;
}
const convKey = () => conv()?.key ?? '';
const msgKey = (m: Msg) => m.grp ? 'g' + m.grp : 'u' + (m.sender === S.me!.id ? m.recipient : m.sender);

// onClick — уведомление можно нажать (например, «показать скачанный файл в папке»)
let toastTimer = 0;
function toast(text: string, onClick?: () => void) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  t.classList.toggle('click', !!onClick);
  t.onclick = onClick ? () => { t.classList.remove('show'); onClick(); } : null;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), onClick ? 7000 : 3500);
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
  closeIncoming();
  closeSettings(true);
  closeDlg();
  closePop();
  closePicker();
  S.token = '';
  S.me = null;
  S.peer = null;
  S.gid = 0;
  S.groups = [];
  S.msgs.clear();
  S.unread.clear();
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
          <div class="dm-head"><span>Личные сообщения</span><button class="ibtn sm" data-act="gnew" title="Создать группу">${ic('plus', 16)}</button></div>
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
  // перетаскивание файлов в открытую беседу
  const chat = $('#chat');
  const hasFiles = (e: DragEvent) => !!conv() && !!e.dataTransfer?.types.includes('Files');
  chat.ondragenter = (e) => {
    if (!hasFiles(e)) return;
    chat.dataset.drop = `Отправить файлы ${S.peer ? '' : 'в '}${conv()!.name}`;
    chat.classList.add('drop');
  };
  chat.ondragover = (e) => { if (hasFiles(e)) e.preventDefault(); };
  chat.ondragleave = (e) => { if (!chat.contains(e.relatedTarget as Node)) chat.classList.remove('drop'); };
  chat.ondrop = (e) => {
    e.preventDefault();
    chat.classList.remove('drop');
    const c = conv();
    if (c && e.dataTransfer?.files.length) sendFiles(c, e.dataTransfer.files);
  };
  renderFriends();
  renderChat();
  renderUserbar();
  connectWs();
  syncServerRingtone();
}

async function act(b: HTMLElement) {
  const id = Number(b.dataset.id);
  // кнопка во всплывающем профиле: сделали дело — профиль закрываем
  if (b.closest('.pop, .pop-sub') && b.dataset.act !== 'statusmenu') closePop();
  switch (b.dataset.act) {
    case 'me': return openSelfPop(b);
    case 'statusmenu': return openStatusMenu(b);
    case 'user': return id === S.me?.id ? openSelfPop(b) : openUserPop(id, b);
    case 'fullprofile': return openFullProfile(id);
    case 'editprofile': return openSettings('profile');
    case 'setstatus': return setStatus(b.dataset.st as Status);
    case 'customst': return customStatusDlg();
    case 'copyid':
      navigator.clipboard.writeText(String(id)).then(() => toast('ID скопирован'), () => toast('Не удалось скопировать'));
      return;
    case 'addfriend': {
      const u = userById(id);
      if (!u) return;
      try {
        S.friends = await api('/api/friends/request', { username: u.username });
        renderFriends();
        toast(friend(id) ? `${uname(u)} теперь в друзьях` : `Запрос дружбы для ${uname(u)} отправлен`);
      } catch (err) { toast((err as Error).message); }
      return;
    }
    case 'home': return goHome();
    case 'tab': S.tab = b.dataset.tab as Tab; return goHome();
    case 'open': { const u = friend(id); return u && openChat(u); }
    case 'call': {
      const u = friend(id);
      if (!u) return;
      if (S.peer?.id !== u.id) openChat(u);
      return startCall(u);
    }
    case 'gopen': return group(id) && openGroup(id);
    case 'gcall':
      if (S.gid !== id) openGroup(id);
      return startGroupCall(id, true);
    // новая группа; из личной беседы — сразу с этим другом
    case 'gnew': return openPicker(0, id ? [id] : []);
    case 'gadd': return openPicker(id);
    case 'grename': return renameGroup(id);
    case 'gkick': case 'gleave': {
      const g = group(Number(b.dataset.gid));
      if (!g) return;
      if (b.dataset.act === 'gleave' && !(await confirmDlg(`Покинуть «${gname(g)}»`,
        'Вы больше не будете получать сообщения из этой группы. Вернуться можно, только если вас снова добавят.', 'Покинуть группу'))) return;
      try { await api('/api/groups/remove', { group: g.id, user: b.dataset.act === 'gkick' ? id : undefined }); }
      catch (err) { toast((err as Error).message); }
      return;
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
    case 'update':
      if (C.state !== 'idle') return toast('Завершите звонок, чтобы обновиться');
      return installUpdate($('#modal'));
    // ссылка скачивает файл сама, здесь только подсказка (в приложении файл тихо ложится в «Загрузки»)
    case 'dl': if (tauri) toast(`Скачиваю «${b.dataset.name}»…`); return;
    case 'view': {
      const f = S.msgs.get(convKey())?.find((m) => m.file?.id === b.dataset.fid)?.file;
      return f && openViewer(f);
    }
    case 'upcancel': {
      const up = S.uploads.find((u) => u.key === id);
      if (up) { up.cancelled = true; up.xhr.abort(); finishUpload(up); }
      return;
    }
  }
}

function goHome() {
  S.peer = null;
  S.gid = 0;
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

// Список групп; если нас убрали из открытой группы или из группы со звонком — уходим оттуда
async function loadGroups() {
  S.groups = await api('/api/groups');
  if (C.gid && C.state !== 'idle' && !group(C.gid)) { toast('Вы больше не в группе'); hangup(false); }
  if (S.gid && !group(S.gid)) return goHome();
  if (C.incomingG && !group(C.incomingG)) closeIncoming();
  if (document.querySelector('.dlg-bg.picker')) closeDlg(); // список друзей в окне выбора устарел
  renderFriends();
  if (!S.gid) return;
  renderMessages(); // ники в шапках сообщений
  const ta = document.querySelector<HTMLTextAreaElement>('#send textarea');
  if (ta) ta.placeholder = composerHint(conv()!); // группу могли переименовать
}

// Всё, что зависит от списка друзей, групп и статусов
function renderFriends() {
  if (!S.me) return;
  const n = S.friends.incoming.length;
  const pill = $('#reqn');
  pill.hidden = !n;
  pill.textContent = String(n);
  $('#navfr').classList.toggle('sel', !conv());
  renderDmList();
  renderRail();
  if (!conv()) return renderHome();
  renderTop();
  renderProfile();
}

const unreadPill = (n: number) => n ? `<span class="pill">${n > 99 ? '99+' : n}</span>` : '';

function renderDmList() {
  const has = (s: string) => !S.filter || s.toLowerCase().includes(S.filter);
  const groups = S.groups.filter((g) => has(gname(g)));
  const list = S.friends.friends.filter((u) => has(u.username) || has(uname(u)));
  $('#flist').innerHTML = groups.map((g) => {
    const unread = S.unread.get('g' + g.id) || 0;
    const sub = C.state !== 'idle' && C.gid === g.id ? `<small class="incall">${ic('volume', 12)}В звонке</small>`
      : g.call.length ? `<small class="incall">${ic('volume', 12)}Звонок: ${g.call.length}</small>`
      : `<small>${g.members.length} ${plural(g.members.length, 'участник', 'участника', 'участников')}</small>`;
    return `
      <div class="dm ${S.gid === g.id ? 'sel' : ''} ${unread ? 'unread' : ''}" data-act="gopen" data-id="${g.id}">
        ${gavatar(g, 32)}
        <div class="dm-n"><span>${esc(gname(g))}</span>${sub}</div>
        ${unreadPill(unread)}
      </div>`;
  }).join('') + list.map((u) => {
    const unread = S.unread.get('u' + u.id) || 0;
    const inCall = C.state !== 'idle' && !C.gid && C.peer?.id === u.id;
    // под именем, как в Discord, — свой статус
    const sub = inCall ? `<small class="incall">${ic('volume', 12)}В звонке</small>` : u.custom && u.online ? `<small>${emojify(u.custom)}</small>` : '';
    return `
      <div class="dm ${S.peer?.id === u.id ? 'sel' : ''} ${unread ? 'unread' : ''}" data-act="open" data-id="${u.id}">
        ${avatar(u, 32, true)}
        <div class="dm-n"><span>${esc(uname(u))}</span>${sub}</div>
        ${unreadPill(unread)}
      </div>`;
  }).join('') || `<div class="muted">${S.filter ? 'Никого не нашлось' : 'Пока никого — добавьте друга'}</div>`;
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

// Левая колонка: «Личные сообщения», непрочитанные беседы и текущий звонок
function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  const ck = C.state !== 'idle' ? callKey() : '';
  const callG = C.gid ? group(C.gid) : undefined;
  // кнопка беседы: аватарка друга или значок группы
  const btn = (key: string, extra: string) => {
    const id = Number(key.slice(1));
    const g = key[0] === 'g' ? group(id) : undefined;
    const u = key[0] === 'u' ? friend(id) : undefined;
    if (!g && !u) return '';
    return `<button class="rb" data-act="${g ? 'gopen' : 'open'}" data-id="${id}" title="${esc(g ? gname(g) : uname(u!))}">${g ? gavatar(g, 48) : avatar(u!, 48)}${extra}</button>`;
  };
  const unread = [...S.unread].filter(([key]) => key !== ck);
  rail.innerHTML = `
    <div class="ri sel"><button class="rb home" data-act="home" title="Личные сообщения">${ic('logo', 28)}</button></div>
    ${ck && (callG || C.peer) ? `<div class="ri">${callG ? btn(ck, `<span class="rb-voice">${ic('volume', 12)}</span>`)
      : `<button class="rb" data-act="open" data-id="${C.peer!.id}" title="${esc(uname(C.peer!))} — звонок">${avatar(C.peer!, 48)}<span class="rb-voice">${ic('volume', 12)}</span></button>`}</div>` : ''}
    ${unread.map(([key, n]) => { const b = btn(key, `<span class="rb-badge">${n > 99 ? '99+' : n}</span>`); return b && `<div class="ri dot">${b}</div>`; }).join('')}
    <div class="rail-sep"></div>
    <div class="ri"><button class="rb add" data-act="tab" data-tab="add" title="Добавить в друзья">${ic('plus', 24)}</button></div>
    ${U.version ? `<div class="ri"><button class="rb add upd" data-act="update" title="Доступно обновление ${esc(U.version)} — нажмите, чтобы установить">${ic('download', 24)}</button></div>` : ''}`;
}

function renderUserbar() {
  const box = document.getElementById('userbar');
  if (!box || !S.me) return;
  const muted = C.selfMute || C.deaf;
  const online = S.ws?.readyState === WebSocket.OPEN;
  // как в Discord: при наведении вместо статуса — ник
  box.innerHTML = `
    <div class="ub-me" data-act="me">${avatar(S.me, 32, true)}
      <div class="ub-n"><b>${esc(uname(S.me))}</b><span class="ub-st">${online ? S.me.custom ? emojify(S.me.custom) : ST_NAME[stOf(S.me)] : 'Подключение…'}</span><span class="ub-u">${esc(S.me.username)}</span></div></div>
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

  // open — строка друга: со статусом, по щелчку — беседа
  const row = (u: User, sub: string, btns: string, open = false) => `
    <div class="frow" ${open ? `data-act="open" data-id="${u.id}"` : ''}>
      ${avatar(u, 32, open)}
      <div class="fr-n"><b>${esc(uname(u))}<i>${esc(u.username)}</i></b><span>${sub}</span></div>
      <div class="fr-btns">${btns}</div>
    </div>`;
  const friendSub = (u: User) => u.custom && u.online ? emojify(u.custom) : ST_NAME[stOf(u)];
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
    rows = list.map((u) => row(u, friendSub(u),
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

// ---------- личные сообщения и группы ----------
function openChat(u: User) {
  S.peer = u;
  S.gid = 0;
  return openConv();
}

function openGroup(id: number) {
  S.peer = null;
  S.gid = id;
  return openConv();
}

async function openConv() {
  const c = conv();
  if (!c) return goHome();
  S.unread.delete(c.key);
  renderFriends();
  renderChat();
  // общие друзья и группы для профиля справа
  if (S.peer) { const id = S.peer.id; loadProfile(id).then(() => S.peer?.id === id && renderProfile()); }
  if (!S.msgs.has(c.key)) {
    const msgs = await api(S.gid ? '/api/group/messages?group=' + S.gid : '/api/dm/messages?peer=' + S.peer!.id);
    S.msgs.set(c.key, msgs);
    if (convKey() === c.key) renderMessages();
  }
}

function renderTop() {
  const p = S.peer;
  const g = S.gid ? group(S.gid) : undefined;
  if (g) {
    const inCall = C.state !== 'idle' && C.gid === g.id;
    $('#topbar').innerHTML = `
      <div class="tb-title">${gavatar(g, 24)}<b class="tb-edit" data-act="grename" data-id="${g.id}" title="Изменить название группы">${esc(gname(g))}</b></div>
      <div class="tb-actions">
        <button class="tb-btn ${g.call.length && !inCall ? 'live' : ''}" data-act="gcall" data-id="${g.id}" title="${g.call.length ? 'Присоединиться к звонку' : 'Начать голосовой звонок'}">${ic('phone', 22)}</button>
        <button class="tb-btn" data-act="gadd" data-id="${g.id}" title="Добавить друзей в группу">${ic('addFriend', 22)}</button>
        <button class="tb-btn ${S.showProfile ? 'on' : ''}" data-act="profile" title="${S.showProfile ? 'Скрыть список участников' : 'Показать список участников'}">${ic('friends', 22)}</button>
      </div>`;
    return;
  }
  if (!p) return;
  $('#topbar').innerHTML = `
    <div class="tb-title tb-user" data-act="user" data-id="${p.id}">${avatar(p, 24, true)}<b>${esc(uname(p))}</b></div>
    <div class="tb-actions">
      <button class="tb-btn" data-act="call" data-id="${p.id}" title="Начать голосовой звонок">${ic('phone', 22)}</button>
      <button class="tb-btn" data-act="gnew" data-id="${p.id}" title="Создать группу с ${esc(uname(p))}">${ic('addFriend', 22)}</button>
      <button class="tb-btn ${S.showProfile ? 'on' : ''}" data-act="profile" title="${S.showProfile ? 'Скрыть профиль' : 'Показать профиль'}">${ic('account', 22)}</button>
    </div>`;
}

const composerHint = (c: Conv) => `Написать ${c.to.group ? `в «${c.name}»` : c.name}`;

function renderChat() {
  syncCallBox();
  const c = conv();
  if (!c) return renderHome();
  renderTop();
  $('#chat').innerHTML = `
    <div id="msgs"></div>
    <form id="send"><div class="ac" hidden></div><div class="composer">
      <button type="button" class="att-btn" id="attach" title="Отправить файл">${ic('attach', 24)}</button>
      <input type="file" id="attfile" multiple hidden>
      <textarea rows="1" maxlength="4000" placeholder="${esc(composerHint(c))}"></textarea>
      <button type="button" class="emo-btn" id="emobtn" title="Выбрать эмодзи"><span class="emo">${EMO_BTN[0]}</span></button>
    </div></form>`;
  const ta = $<HTMLTextAreaElement>('#send textarea');
  const pick = $<HTMLInputElement>('#attfile');
  $('#attach').onclick = () => pick.click();
  bindEmoji(ta, $('#emobtn'), $('#send .ac'));
  pick.onchange = () => { if (pick.files?.length) sendFiles(c, pick.files); pick.value = ''; ta.focus(); };
  // вставка из буфера обмена: скриншоты и скопированные в проводнике файлы
  ta.onpaste = (e) => {
    const files = e.clipboardData?.files;
    if (files?.length) { e.preventDefault(); sendFiles(c, files); }
  };
  const box = $('#msgs');
  box.onscroll = () => { msgStick = box.scrollHeight - box.scrollTop - box.clientHeight < 80; };
  // картинка без известного размера догрузилась — не даём ленте уехать вверх
  box.addEventListener('load', () => { if (msgStick) box.scrollTop = box.scrollHeight; }, true);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'; };
  const send = async () => {
    const text = replaceCodes(ta.value.trim());
    if (!text) return;
    ta.value = '';
    grow();
    noteUsed(text);
    try { await api(c.to.group ? '/api/group/messages' : '/api/dm/messages', { ...c.to, text }); } catch (err) { toast((err as Error).message); }
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return; // Enter выбрал подсказку эмодзи
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  ta.focus();
  renderMessages();
  renderProfile();
}

// ---------- эмодзи в поле ввода ----------
// кнопка как в Discord: серая, при наведении цветная и каждый раз новая рожица
const EMO_BTN = ['😀', '😁', '😆', '😅', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😋', '😛', '🤪', '🤓', '😎', '🥳', '😏', '🤗', '🤔', '😮', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱', '🤠'];

// Вставка в поле ввода на место курсора (с пробелом, если вплотную к тексту)
function insertText(ta: HTMLTextAreaElement | HTMLInputElement, text: string, from = ta.selectionStart ?? ta.value.length, to = ta.selectionEnd ?? from) {
  const before = ta.value.slice(0, from);
  const add = (before && !/\s$/.test(before) && ta instanceof HTMLTextAreaElement ? ' ' : '') + text;
  if (ta.maxLength > 0 && ta.value.length - (to - from) + add.length > ta.maxLength) return;
  ta.value = before + add + ta.value.slice(to);
  const pos = from + add.length;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

// Кнопка выбора эмодзи у поля и подсказки «:код» (ac — список подсказок; без него — только кнопка)
function bindEmoji(ta: HTMLTextAreaElement | HTMLInputElement, btn: HTMLElement, ac?: HTMLElement) {
  btn.onmouseenter = () => { btn.querySelector('.emo')!.textContent = EMO_BTN[Math.floor(Math.random() * EMO_BTN.length)]; };
  btn.onclick = () => openEmojiPicker(btn, (u) => insertText(ta, u));
  if (!ac) return;
  const el: HTMLElement = ta; // у объединения типов addEventListener не знает KeyboardEvent
  let items: { u: string; name: string }[] = [];
  let sel = 0;
  let start = 0; // где начинается «:код»
  const hide = () => { ac.hidden = true; items = []; };
  const draw = () => {
    ac.innerHTML = `<h5>Эмодзи, совпадающие с <b>:${esc(ta.value.slice(start + 1, ta.selectionStart ?? 0))}</b></h5>` + items.map((it, i) =>
      `<div class="ac-row ${i === sel ? 'sel' : ''}" data-i="${i}"><span class="emo">${it.u}</span><span>:${esc(it.name)}:</span></div>`).join('');
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    hide();
    insertText(ta, it.u + ' ', start, ta.selectionStart ?? start);
  };
  el.addEventListener('input', async () => {
    const pos = ta.selectionStart ?? 0;
    const m = /(^|\s):([\p{L}\d_+-]{2,})$/u.exec(ta.value.slice(0, pos));
    if (!m) return hide();
    await loadEmoji();
    if ((ta.selectionStart ?? 0) !== pos) return; // пока грузили данные, набрали дальше
    start = pos - m[2].length - 1;
    items = suggest(m[2]);
    sel = 0;
    if (!items.length) return hide();
    ac.hidden = false;
    draw();
  });
  el.addEventListener('keydown', (e) => {
    if (ac.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });
  el.addEventListener('blur', () => setTimeout(hide, 150));
  ac.onmousedown = (e) => {
    e.preventDefault(); // не теряем фокус поля
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ac-row');
    if (row) choose(Number(row.dataset.i));
  };
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
function stamp(t: number) {
  const hm = new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(t, Date.now())) return 'сегодня в ' + hm;
  if (sameDay(t, Date.now() - 864e5)) return 'вчера в ' + hm;
  return new Date(t).toLocaleDateString('ru') + ' ' + hm;
}

const fsize = (n: number) =>
  n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(2)} ГБ`;
// токен в ссылке: <img> и <video> не умеют слать заголовок Authorization
const fileUrl = (f: Att, dl = false) => `${S.server}/api/files/${f.id}?${dl ? 'dl=1&' : ''}token=${encodeURIComponent(S.token)}`;
// что показываем прямо в чате (то же, что сервер отдаёт inline)
const IMG_RE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const VID_RE = /^video\/(mp4|webm|ogg)$/;

// Превью не больше 520×350, с заранее известным размером (лента не дёргается при загрузке)
function mediaBox(f: Att) {
  if (!f.w || !f.h) return 'max-width:520px;max-height:350px';
  const k = Math.min(1, 520 / f.w, 350 / f.h);
  return `width:${Math.max(1, Math.round(f.w * k))}px;aspect-ratio:${f.w}/${f.h}`;
}

function renderAtt(f: Att) {
  const dl = `href="${esc(fileUrl(f, true))}" data-act="dl" data-name="${esc(f.name)}"`;
  if (IMG_RE.test(f.type))
    return `<div class="att-media img" style="${mediaBox(f)}" data-act="view" data-fid="${f.id}" title="${esc(f.name)}"><img data-fid="${f.id}" src="${esc(fileUrl(f))}" alt="${esc(f.name)}" draggable="false"></div>`;
  if (VID_RE.test(f.type))
    return `<div class="att-media" style="${mediaBox(f)}"><video data-fid="${f.id}" src="${esc(fileUrl(f))}" controls preload="metadata"></video></div>
      <div class="att-cap"><a ${dl}>${esc(f.name)}</a><span>${fsize(f.size)}</span></div>`;
  const audio = f.type.startsWith('audio/');
  return `
    <div class="att ${audio ? 'audio' : ''}">
      <span class="att-ic">${ic(audio ? 'music' : 'file', 30)}</span>
      <div class="att-n"><a ${dl} title="${esc(f.name)}">${esc(f.name)}</a><span>${fsize(f.size)}</span></div>
      <a class="att-dl" ${dl} title="Скачать">${ic('download', 22)}</a>
      ${audio ? `<audio data-fid="${f.id}" src="${esc(fileUrl(f))}" controls preload="none"></audio>` : ''}
    </div>`;
}

function renderUpload(u: Upload) {
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  return `
    <div class="msg cont up" data-up="${u.key}">
      <div class="att">
        <span class="att-ic">${ic('file', 30)}</span>
        <div class="att-n"><b title="${esc(u.name)}">${esc(u.name)}</b>
          <div class="up-bar"><i style="width:${pct}%"></i></div>
          <span class="up-txt">${fsize(u.sent)} из ${fsize(u.size)}</span></div>
        <button class="att-dl" data-act="upcancel" data-id="${u.key}" title="Отменить">${ic('close', 22)}</button>
      </div>
    </div>`;
}

let msgStick = true; // лента прокручена до конца — новые сообщения держим в поле зрения
// Системное сообщение группы: «X добавил(а) Y в группу» и т.п.
function renderSys(m: Msg, who: string) {
  const b = (s: string) => `<b>${esc(s)}</b>`;
  const [icon, cls, text] = {
    create: ['arrowIn', 'in', `${b(who)} создал(а) группу.`],
    add: ['arrowIn', 'in', `${b(who)} добавил(а) ${b(m.text)} в группу.`],
    leave: ['arrowOut', 'out', `${b(m.text)} покинул(а) группу.`],
    kick: ['arrowOut', 'out', `${b(who)} исключил(а) ${b(m.text)} из группы.`],
    rename: ['edit', '', m.text ? `${b(who)} изменил(а) название группы: ${b(m.text)}` : `${b(who)} убрал(а) название группы.`],
    call: ['phone', 'in', `${b(who)} начал(а) звонок.`],
  }[m.kind!] as [keyof typeof ICON, string, string];
  return `<div class="msg sys"><span class="sys-ic ${cls}">${ic(icon, 18)}</span><p>${text} <time>${stamp(m.created)}</time></p></div>`;
}

function renderMessages() {
  const box = document.getElementById('msgs');
  const c = conv();
  if (!box || !c) return;
  const me = S.me!;
  const p = S.peer;
  const g = S.gid ? group(S.gid) : undefined;
  let html = p
    ? `<div class="intro">${avatar(p, 80)}<h1>${esc(uname(p))}</h1><div class="intro-u">${esc(p.username)}</div>
        <p>Это начало истории ваших личных сообщений с <b>${esc(uname(p))}</b>.</p></div>`
    : `<div class="intro">${gavatar(g!, 80)}<h1>${esc(c.name)}</h1>
        <p>Добро пожаловать в начало группы <b>${esc(c.name)}</b>.</p></div>`;
  // автор: в группе — участник (или ник из сообщения, если он уже вышел)
  const author = (m: Msg): User => m.sender === me.id ? me : p ?? userById(m.sender) ?? { id: m.sender, username: m.sname || '???' };
  let prev: Msg | null = null;
  let last = 0; // время предыдущего сообщения — для разделителя дней
  for (const m of S.msgs.get(c.key) || []) {
    if (!last || !sameDay(last, m.created))
      html += `<div class="day"><span>${new Date(m.created).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>`;
    last = m.created;
    if (m.kind) {
      html += renderSys(m, uname(author(m)));
      prev = null;
      continue;
    }
    const text = (m.text ? `<p${isJumbo(m.text) ? ' class="jumbo"' : ''}>${emojify(m.text)}</p>` : '') + (m.file ? renderAtt(m.file) : '');
    // подряд идущие сообщения одного автора в пределах 7 минут — одной группой, как в Discord
    if (prev && prev.sender === m.sender && m.created - prev.created < 7 * 60e3 && sameDay(prev.created, m.created)) {
      html += `<div class="msg cont"><time>${new Date(m.created).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time>${text}</div>`;
    } else {
      const u = author(m);
      const who = `data-act="user" data-id="${u.id}"`;
      html += `<div class="msg head"><span class="mav" ${who}>${avatar(u, 40)}</span><div class="mh"><b ${who}>${esc(uname(u))}</b><time>${stamp(m.created)}</time></div>${text}</div>`;
    }
    prev = m;
  }
  html += S.uploads.filter((u) => u.conv === c.key).map(renderUpload).join('');
  // уже показанные картинки и плееры переносим в новую разметку как есть:
  // не перекачиваются, а видео/музыка не останавливаются, когда приходит новое сообщение
  const keep = new Map([...box.querySelectorAll<HTMLElement>('img[data-fid], video[data-fid], audio[data-fid]')].map((el) => [el.dataset.fid!, el]));
  box.innerHTML = html;
  box.querySelectorAll<HTMLElement>('img[data-fid], video[data-fid], audio[data-fid]').forEach((el) => {
    const old = keep.get(el.dataset.fid!);
    if (old) el.replaceWith(old);
  });
  box.scrollTop = box.scrollHeight;
  msgStick = true;
}

// ---------- файлы ----------
const MAX_FILE = 500 * 1024 * 1024; // как на сервере
let upSeq = 0;

type Conv = NonNullable<ReturnType<typeof conv>>;

function sendFiles(c: Conv, files: FileList) {
  for (const f of [...files]) uploadFile(c, f);
}

// Размер картинки/видео для превью (читаем локальный файл, на сервер это не уходит)
function mediaSize(file: File): Promise<[number, number] | null> {
  const img = IMG_RE.test(file.type);
  if (!img && !VID_RE.test(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const end = (r: [number, number] | null) => { URL.revokeObjectURL(url); resolve(r); };
    setTimeout(() => end(null), 5000);
    if (img) {
      const i = new Image();
      i.onload = () => end(i.naturalWidth ? [i.naturalWidth, i.naturalHeight] : null);
      i.onerror = () => end(null);
      i.src = url;
    } else {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => end(v.videoWidth ? [v.videoWidth, v.videoHeight] : null);
      v.onerror = () => end(null);
      v.src = url;
    }
  });
}

function finishUpload(up: Upload, err?: string) {
  const i = S.uploads.indexOf(up);
  if (i < 0) return;
  S.uploads.splice(i, 1);
  document.querySelector(`[data-up="${up.key}"]`)?.remove();
  if (err) toast(err);
}

// Файл уходит на сервер одним запросом; сообщение с ним придёт обоим через WebSocket
async function uploadFile(c: Conv, file: File) {
  if (!file.size) return toast(`«${file.name}» — пустой файл (папки отправить нельзя)`);
  if (file.size > MAX_FILE) return toast(`«${file.name}» больше ${MAX_FILE / 1048576} МБ`);
  const up: Upload = { key: ++upSeq, conv: c.key, name: file.name, size: file.size, sent: 0, xhr: new XMLHttpRequest() };
  S.uploads.push(up);
  if (convKey() === c.key) renderMessages();
  const dims = await mediaSize(file);
  if (up.cancelled) return;
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(c.to).map(([k, v]) => [k, String(v)])), name: file.name });
  if (dims) { qs.set('w', String(dims[0])); qs.set('h', String(dims[1])); }
  const xhr = up.xhr;
  const fail = (why: string) => `Не удалось отправить «${file.name}»: ${why}`;
  xhr.open('POST', `${S.server}/api/dm/file?${qs}`);
  xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (e) => {
    up.sent = e.loaded;
    const row = document.querySelector(`[data-up="${up.key}"]`);
    if (!row) return;
    $('.up-bar i', row).style.width = `${Math.min(100, (e.loaded / up.size) * 100)}%`;
    $('.up-txt', row).textContent = e.loaded >= up.size ? 'Обработка…' : `${fsize(e.loaded)} из ${fsize(up.size)}`;
  };
  xhr.onload = () => {
    if (xhr.status === 200) return finishUpload(up);
    let why = 'HTTP ' + xhr.status;
    try { why = JSON.parse(xhr.responseText).error || why; } catch {}
    finishUpload(up, fail(why));
  };
  xhr.onerror = () => finishUpload(up, fail('нет связи с сервером'));
  xhr.onabort = () => finishUpload(up);
  xhr.send(file);
}

// Просмотр картинки во весь экран
function openViewer(f: Att) {
  closeViewer();
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <img src="${esc(fileUrl(f))}" alt="${esc(f.name)}">
    <div class="lb-bar"><span>${esc(f.name)} • ${fsize(f.size)}</span>
      <a href="${esc(fileUrl(f, true))}" class="lb-dl">${ic('download', 18)}Скачать</a></div>`;
  lb.onclick = (e) => {
    if ((e.target as HTMLElement).closest('.lb-dl')) { if (tauri) toast(`Скачиваю «${f.name}»…`); return; }
    if ((e.target as HTMLElement).tagName !== 'IMG') closeViewer();
  };
  document.body.append(lb);
}
const closeViewer = () => document.querySelector('.lightbox')?.remove();

// Файл, брошенный мимо чата, не должен открываться в окне приложения вместо Startrack
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Профиль собеседника справа (во время звонка с ним прячется, как в Discord), в группе — участники
function renderProfile() {
  const box = document.getElementById('profile');
  const p = S.peer;
  if (!box) return;
  const g = S.gid ? group(S.gid) : undefined;
  if (g) {
    box.hidden = !S.showProfile;
    if (!box.hidden) renderMembers(box, g);
    return;
  }
  box.hidden = !p || !S.showProfile || (C.state !== 'idle' && callKey() === 'u' + p.id);
  if (box.hidden || !p) return;
  const prof = S.profiles.get(p.id);
  // общие группы и друзья — сворачиваемыми списками, как в Discord
  const mutual = (title: string, rows: string[]) => rows.length
    ? `<details class="pf-mut"><summary>${title} — ${rows.length}${ic('chevron', 16)}</summary>${rows.join('')}</details>` : '';
  const groups = (prof?.mutualGroups ?? []).map(group).filter((g): g is Group => !!g)
    .map((g) => `<div class="pf-row" data-act="gopen" data-id="${g.id}">${gavatar(g, 32)}<span>${esc(gname(g))}</span></div>`);
  const friends = (prof?.mutualFriends ?? []).map(friend).filter((u): u is User => !!u)
    .map((u) => `<div class="pf-row" data-act="user" data-id="${u.id}">${avatar(u, 32, true)}<span>${esc(uname(u))}</span></div>`);
  box.innerHTML = `
    <div class="pf">
      ${cardHtml(p, 'side', infoHtml(p) + (groups.length || friends.length
        ? `<div class="pc-sec pf-muts">${mutual('Общие группы', groups)}${mutual('Общие друзья', friends)}</div>` : ''))}
      <button class="pf-btn" data-act="fullprofile" data-id="${p.id}">Открыть полный профиль</button>
    </div>`;
}

// ---------- профили ----------
const since = (t?: number) => t ? new Date(t).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const statusDot = (s: Status) => `<i class="sti ${s}"></i>`;

// Карточка профиля, как в Discord: баннер, аватарка, «пузырь» своего статуса, имя, ник и местоимения.
// mode: pop — всплывающая, side — справа в беседе, full — полный профиль, preview — в редакторе, self — своя всплывающая
function cardHtml(u: User, mode: 'pop' | 'side' | 'full' | 'preview' | 'self', body = '') {
  const bubble = u.custom ? `<div class="pc-bubble" ${mode === 'self' ? 'data-act="customst" title="Изменить статус"' : ''}>${emojify(u.custom)}</div>`
    : mode === 'self' ? `<div class="pc-bubble empty" data-act="customst">${ic('plus', 14)}Как настроение?</div>`
    : mode === 'preview' ? '<div class="pc-bubble empty">Свой статус</div>' : '';
  return `
    <div class="pc m-${mode}">
      <div class="pc-banner" style="${bannerStyle(u)}"></div>
      <div class="pc-av">${avatar(u, mode === 'full' ? 120 : 80, true)}</div>
      ${bubble}
      <div class="pc-body">
        <div class="pc-names"><h2>${esc(uname(u))}</h2><div class="pc-u">${esc(u.username)}${u.pronouns ? `<span>•</span>${esc(u.pronouns)}` : ''}</div></div>
        ${body}
      </div>
    </div>`;
}
// «Обо мне» и дата регистрации
const infoHtml = (u: User) =>
  (u.bio ? `<div class="pc-sec"><h4>Обо мне</h4><p class="pc-bio">${emojify(u.bio)}</p></div>` : '')
  + (u.created ? `<div class="pc-sec"><h4>В Startrack с</h4><span>${since(u.created)}</span></div>` : '');

// Профиль с сервера: свежие поля и общие друзья/группы
async function loadProfile(id: number) {
  try {
    const p: Profile = await api('/api/users/profile?id=' + id);
    S.profiles.set(id, p);
    const { mutualFriends: _f, mutualGroups: _g, ...u } = p;
    if (id !== S.me?.id) mergeUser(u);
    return p;
  } catch { return null; }
}

// Новые данные человека — во все места, где он у нас есть (друзья, заявки, участники групп, звонок)
function mergeUser(u: User) {
  const copies = [...S.friends.friends, ...S.friends.incoming, ...S.friends.outgoing, ...S.groups.flatMap((g) => g.members),
    S.peer, C.peer, C.incoming].filter((x): x is User => x?.id === u.id);
  for (const x of new Set(copies)) Object.assign(x, u);
}

// ---------- всплывающие окна профиля ----------
let popAnchor: HTMLElement | null = null;
function closePop() {
  document.querySelector('.pop')?.remove();
  document.querySelector('.pop-sub')?.remove();
  popAnchor = null;
}
// Повторный щелчок по тому же месту закрывает окно
function popToggled(anchor: HTMLElement) {
  if (popAnchor === anchor && document.querySelector('.pop')) { closePop(); return true; }
  return false;
}
// place: right — справа от anchor (сообщения), left — слева (участники справа), up — над ним (панель пользователя)
type Place = 'right' | 'left' | 'up';
function placePop(el: HTMLElement, anchor: HTMLElement, place: Place) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const x = place === 'up' ? r.left : place === 'left' ? r.left - w - 12 : r.right + 12;
  const y = place === 'up' ? r.top - h - 8 : r.top;
  el.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
}
function showPop(anchor: HTMLElement, html: string, place: Place) {
  closePop();
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = html;
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (b) act(b);
  };
  document.body.append(el);
  popAnchor = anchor;
  placePop(el, anchor, place);
  return el;
}
document.addEventListener('mousedown', (e) => {
  const t = e.target as Node;
  const inside = [document.querySelector('.pop'), document.querySelector('.pop-sub'), popAnchor].some((x) => x?.contains(t));
  if (document.querySelector('.pop') && !inside) closePop();
}, true);

const placeFor = (anchor: HTMLElement): Place => anchor.closest('.userbar') ? 'up' : anchor.closest('#profile, .tb-user') ? 'left' : 'right';

// Свой профиль по щелчку на себя внизу слева: «Редактировать профиль», статус, свой статус
function openSelfPop(anchor: HTMLElement) {
  if (popToggled(anchor) || !S.me) return;
  const me = S.me;
  const st = me.status || 'online';
  const el = showPop(anchor, cardHtml(me, 'self', `
    <div class="pop-menu">
      <button data-act="editprofile">${ic('edit', 18)}<span>Редактировать профиль</span></button>
      <div class="pm-sep"></div>
      <button class="pm-st" data-act="statusmenu">${statusDot(st)}<span>${ST_NAME[st]}</span>${ic('chevron', 18)}</button>
    </div>
    <div class="pop-menu"><button data-act="copyid" data-id="${me.id}">${ic('copy', 18)}<span>Скопировать ID пользователя</span></button></div>`), placeFor(anchor));
  const row = $('.pm-st', el);
  row.onmouseenter = () => openStatusMenu(row);
  el.querySelectorAll<HTMLElement>('.pop-menu button:not(.pm-st)').forEach((b) => (b.onmouseenter = () => document.querySelector('.pop-sub')?.remove()));
}

// Подменю статусов справа от строки статуса (как на скриншоте Discord)
function openStatusMenu(row: HTMLElement) {
  if (document.querySelector('.pop-sub')) return;
  const cur = S.me?.status || 'online';
  const opt = (s: Status, hint = '') =>
    `<button class="${cur === s ? 'on' : ''}" data-act="setstatus" data-st="${s}">${statusDot(s)}<div><b>${ST_NAME[s]}</b>${hint ? `<span>${hint}</span>` : ''}</div></button>`;
  const el = document.createElement('div');
  el.className = 'pop-sub';
  el.innerHTML = `${opt('online')}<div class="pm-sep"></div>${opt('idle')}${opt('dnd', 'Входящие звонки будут без звука')}${opt('invisible', 'Вы будете казаться не в сети')}`;
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (b) act(b);
  };
  document.body.append(el);
  const r = row.getBoundingClientRect();
  const left = r.right + 8 + el.offsetWidth < innerWidth ? r.right + 8 : r.left - el.offsetWidth - 8;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = Math.max(8, Math.min(r.top - 8, innerHeight - el.offsetHeight - 8)) + 'px';
}

async function setStatus(status: Status) {
  try {
    Object.assign(S.me!, await api('/api/me/status', { status }));
    renderMe();
  } catch (err) { toast((err as Error).message); }
}

// Всё, где видны свои имя, аватарка и статус (и свои копии в списках участников групп)
function renderMe() {
  if (!S.me) return;
  const { status: _s, ...me } = S.me;
  mergeUser(me);
  renderUserbar();
  renderFriends();
  renderMessages();
}

// Кнопки под чужим профилем: написать/позвонить другу или заявка в друзья
function userActions(u: User) {
  if (friend(u.id)) return `
    <div class="pc-btns">
      <button class="btn" data-act="open" data-id="${u.id}">${ic('chat', 18)}Написать</button>
      <button class="btn sec pc-call" data-act="call" data-id="${u.id}" title="Позвонить">${ic('phone', 18)}</button>
    </div>`;
  if (S.friends.incoming.some((x) => x.id === u.id))
    return `<div class="pc-btns"><button class="btn green" data-act="accept" data-id="${u.id}">${ic('check', 18)}Принять заявку в друзья</button></div>`;
  if (S.friends.outgoing.some((x) => x.id === u.id))
    return `<div class="pc-btns"><button class="btn sec" disabled>Запрос дружбы отправлен</button></div>`;
  return `<div class="pc-btns"><button class="btn" data-act="addfriend" data-id="${u.id}">${ic('addFriend', 18)}Добавить в друзья</button></div>`;
}

// «3 общих друга • 2 общие группы» с аватарками, как в Discord
function mutualLine(id: number) {
  const p = S.profiles.get(id);
  if (!p) return '';
  const fr = p.mutualFriends.map(friend).filter((u): u is User => !!u);
  const gr = p.mutualGroups.filter((g) => group(g));
  const parts = [];
  if (fr.length) parts.push(`<span class="pc-stack">${fr.slice(0, 3).map((u) => avatar(u, 16)).join('')}</span>${fr.length} ${plural(fr.length, 'общий друг', 'общих друга', 'общих друзей')}`);
  if (gr.length) parts.push(`${gr.length} ${plural(gr.length, 'общая группа', 'общие группы', 'общих групп')}`);
  return parts.length ? `<div class="pc-mut" data-act="fullprofile" data-id="${id}">${parts.join('<i>•</i>')}</div>` : '';
}

// Чужой профиль по щелчку на аватарку или имя
async function openUserPop(id: number, anchor: HTMLElement) {
  if (popToggled(anchor)) return;
  if (!userById(id)) return;
  const place = placeFor(anchor);
  const draw = () => {
    const u = userById(id)!;
    return cardHtml(u, 'pop', mutualLine(id) + infoHtml(u) + userActions(u)
      + `<button class="pc-full" data-act="fullprofile" data-id="${id}">Открыть полный профиль</button>`);
  };
  const el = showPop(anchor, draw(), place);
  await loadProfile(id);
  if (!el.isConnected || !userById(id)) return;
  el.innerHTML = draw();
  placePop(el, anchor, place);
}

// Полный профиль: слева карточка, справа общие друзья и группы
async function openFullProfile(id: number) {
  if (!userById(id)) return;
  let tab: 'friends' | 'groups' = 'friends';
  const draw = () => {
    const u = userById(id)!;
    const p = S.profiles.get(id);
    const fr = (p?.mutualFriends ?? []).map(friend).filter((x): x is User => !!x);
    const gr = (p?.mutualGroups ?? []).map(group).filter((g): g is Group => !!g);
    const rows = tab === 'friends'
      ? fr.map((x) => `<div class="pf-row" data-act="open" data-id="${x.id}">${avatar(x, 40, true)}<div><b>${esc(uname(x))}</b><span>${esc(x.username)}</span></div></div>`)
      : gr.map((g) => `<div class="pf-row" data-act="gopen" data-id="${g.id}">${gavatar(g, 40)}<div><b>${esc(gname(g))}</b><span>${g.members.length} ${plural(g.members.length, 'участник', 'участника', 'участников')}</span></div></div>`);
    const self = id === S.me?.id;
    return `
      <div class="fp-left">${cardHtml(u, 'full', (self ? '' : userActions(u)) + infoHtml(u))}</div>
      <div class="fp-right">
        <nav class="fp-tabs">
          <button data-tab="friends" class="${tab === 'friends' ? 'sel' : ''}">Общие друзья${p ? ` — ${fr.length}` : ''}</button>
          <button data-tab="groups" class="${tab === 'groups' ? 'sel' : ''}">Общие группы${p ? ` — ${gr.length}` : ''}</button>
        </nav>
        <div class="fp-list">${rows.join('') || `<div class="fp-empty">${!p ? '<span class="spin"></span>' : self ? 'Это вы 🙂' : tab === 'friends' ? 'Нет общих друзей' : 'Нет общих групп'}</div>`}</div>
      </div>`;
  };
  const bg = showDlg('fullpf', draw());
  const dlg = $('.dlg', bg);
  bg.onclick = (e) => {
    const t = e.target as HTMLElement;
    const tb = t.closest<HTMLElement>('[data-tab]');
    if (tb) { tab = tb.dataset.tab as typeof tab; dlg.innerHTML = draw(); return; }
    const b = t.closest<HTMLElement>('[data-act]');
    if (!b || b.hasAttribute('disabled')) return;
    if (b.dataset.act !== 'accept' && b.dataset.act !== 'addfriend') closeDlg();
    act(b).then(() => { if (bg.isConnected) dlg.innerHTML = draw(); });
  };
  await loadProfile(id);
  if (bg.isConnected) dlg.innerHTML = draw();
}

// Свой статус — «пузырь» у аватарки
function customStatusDlg() {
  const bg = showDlg('cstatus', `
    <h3>Задать свой статус</h3>
    <p>Его видно в вашем профиле и в списках друзей.</p>
    <div class="cst-in"><input maxlength="128" placeholder="Чем заняты?" spellcheck="false" value="${esc(S.me?.custom || '')}">
      <button type="button" class="emo-btn" title="Выбрать эмодзи"><span class="emo">${EMO_BTN[0]}</span></button></div>
    <div class="dlg-btns"><button class="btn sec" data-r="clear">Очистить</button><span class="grow"></span><button class="btn sec" data-r="0">Отмена</button><button class="btn" data-r="1">Сохранить</button></div>`);
  const inp = $<HTMLInputElement>('input', bg);
  bindEmoji(inp, $('.emo-btn', bg));
  inp.focus();
  const save = async (custom: string) => {
    try {
      Object.assign(S.me!, await api('/api/me/profile', { custom }));
      closeDlg();
      renderMe();
    } catch (err) { toast((err as Error).message); }
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') save(inp.value); };
  $('[data-r="1"]', bg).onclick = () => save(inp.value);
  $('[data-r="clear"]', bg).onclick = () => save('');
  $('[data-r="0"]', bg).onclick = closeDlg;
}

// Участники группы: в сети сверху, корона у владельца; владелец может исключать
function renderMembers(box: HTMLElement, g: Group) {
  const me = S.me!;
  const inCall = new Set(g.call);
  const sorted = [...g.members].sort((a, b) => Number(stOf(b) !== 'offline') - Number(stOf(a) !== 'offline'));
  box.innerHTML = `
    <div class="pf mem">
      <h4 class="mem-h">Участники — ${g.members.length}</h4>
      <div class="mem-list">${sorted.map((u) => `
        <div class="mem-row ${stOf(u) === 'offline' ? 'off' : ''}" data-act="user" data-id="${u.id}">
          ${avatar(u, 32, true)}
          <span class="mem-n"><b>${esc(uname(u))}</b>${u.custom && stOf(u) !== 'offline' ? `<small>${emojify(u.custom)}</small>` : ''}</span>
          ${g.owner === u.id ? `<span class="mem-own" title="Владелец группы">${ic('crown', 14)}</span>` : ''}
          ${inCall.has(u.id) ? `<span class="mem-call" title="В звонке">${ic('volume', 14)}</span>` : ''}
          ${g.owner === me.id && u.id !== me.id ? `<button class="ibtn sm mem-kick" data-act="gkick" data-gid="${g.id}" data-id="${u.id}" title="Исключить из группы">${ic('close', 14)}</button>` : ''}
        </div>`).join('')}
      </div>
      <button class="pf-btn" data-act="gadd" data-id="${g.id}">${ic('addFriend', 18)}Добавить друзей</button>
      <button class="pf-btn red" data-act="gleave" data-gid="${g.id}">${ic('leave', 18)}Покинуть группу</button>
    </div>`;
}

// ---------- окна: выбор друзей для группы, подтверждение ----------
const MAX_GROUP = 10; // как на сервере
function closeDlg() {
  document.querySelector('.dlg-bg')?.remove();
}
function showDlg(cls: string, html: string) {
  closeDlg();
  const bg = document.createElement('div');
  bg.className = 'dlg-bg ' + cls;
  bg.innerHTML = `<div class="dlg">${html}</div>`;
  bg.onmousedown = (e) => { if (e.target === bg) closeDlg(); };
  document.body.append(bg);
  return bg;
}

function confirmDlg(title: string, text: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bg = showDlg('confirm', `
      <h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="dlg-btns"><button class="btn sec" data-r="0">Отмена</button><button class="btn red" data-r="1">${esc(ok)}</button></div>`);
    new MutationObserver((_, o) => { if (!bg.isConnected) { o.disconnect(); resolve(false); } }).observe(document.body, { childList: true });
    bg.querySelectorAll<HTMLElement>('[data-r]').forEach((b) => (b.onclick = () => { resolve(b.dataset.r === '1'); closeDlg(); }));
  });
}

// Выбор друзей: gid = 0 — новая группа (preset — уже отмеченные), иначе добавление в группу gid
function openPicker(gid: number, preset: number[] = []) {
  const g = gid ? group(gid) : undefined;
  if (gid && !g) return;
  const taken = new Set(g?.members.map((u) => u.id) ?? []);
  const room = MAX_GROUP - (g ? g.members.length : 1); // сколько ещё можно позвать
  const friends = S.friends.friends.filter((u) => !taken.has(u.id));
  const sel = new Set(preset.filter((id) => friends.some((u) => u.id === id)));
  const bg = showDlg('picker', `
    <h3>${g ? `Добавить в «${esc(gname(g))}»` : 'Выберите друзей'}</h3>
    <p class="pk-left"></p>
    <input class="pk-find" placeholder="Введите ник друга" spellcheck="false">
    <div class="pk-list"></div>
    <div class="dlg-btns"><button class="btn sec" data-r="0">Отмена</button><button class="btn" data-r="1"></button></div>`);
  const list = $('.pk-list', bg);
  const go = $<HTMLButtonElement>('[data-r="1"]', bg);
  const find = $<HTMLInputElement>('.pk-find', bg);
  const draw = () => {
    const left = room - sel.size;
    $('.pk-left', bg).textContent = left > 0 ? `Можно добавить ещё ${left} ${plural(left, 'друга', 'друзей', 'друзей')}.` : 'Больше добавить нельзя: в группе не больше 10 участников.';
    const f = find.value.trim().toLowerCase();
    const shown = friends.filter((u) => !f || u.username.toLowerCase().includes(f) || uname(u).toLowerCase().includes(f));
    list.innerHTML = shown.map((u) => `
      <label class="pk-row ${sel.has(u.id) ? 'on' : ''}">
        ${avatar(u, 32, true)}<span class="pk-n">${esc(uname(u))}</span>
        <input type="checkbox" data-id="${u.id}" ${sel.has(u.id) ? 'checked' : ''} ${!sel.has(u.id) && left <= 0 ? 'disabled' : ''}>
      </label>`).join('') || `<div class="muted">${friends.length ? 'Никого не нашлось' : g ? 'Все ваши друзья уже в группе' : 'Сначала добавьте друзей'}</div>`;
    go.textContent = g ? 'Добавить' : 'Создать группу';
    go.disabled = !sel.size;
  };
  list.onchange = (e) => {
    const cb = e.target as HTMLInputElement;
    const id = Number(cb.dataset.id);
    if (cb.checked) sel.add(id); else sel.delete(id);
    draw();
  };
  find.oninput = draw;
  find.focus();
  $('[data-r="0"]', bg).onclick = closeDlg;
  go.onclick = async () => {
    go.disabled = true;
    try {
      if (g) {
        await api('/api/groups/add', { group: g.id, users: [...sel] });
        closeDlg();
      } else {
        const ng: Group = await api('/api/groups/create', { users: [...sel] });
        closeDlg();
        if (!group(ng.id)) S.groups.push(ng);
        openGroup(ng.id);
      }
    } catch (err) {
      toast((err as Error).message);
      go.disabled = false;
    }
  };
  draw();
}

// Название группы правится прямо в шапке, как в Discord
function renameGroup(gid: number) {
  const g = group(gid);
  const b = document.querySelector<HTMLElement>('#topbar .tb-edit');
  if (!g || !b) return;
  const inp = document.createElement('input');
  inp.className = 'tb-name';
  inp.value = g.name;
  inp.maxLength = 100;
  inp.placeholder = gname({ ...g, name: '' });
  b.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const save = async (ok: boolean) => {
    if (done) return;
    done = true;
    const name = inp.value.trim();
    if (ok && name !== g.name) {
      try { await api('/api/groups/rename', { group: gid, name }); } catch (err) { toast((err as Error).message); }
    }
    renderTop();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') save(true);
    if (e.key === 'Escape') { e.stopPropagation(); save(false); }
  };
  inp.onblur = () => save(true);
}

// ---------- realtime ----------
function connectWs() {
  const ws = new WebSocket(S.server.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(S.token));
  S.ws = ws;
  ws.onopen = () => {
    renderUserbar();
    loadFriends().catch(() => {});
    loadGroups().catch(() => {});
    // сервер узнаёт, кто в групповом звонке, по соединению — после обрыва напоминаем
    if (C.gid && C.state !== 'idle') wsSend({ type: 'gcall_join', group: C.gid, ring: false });
    if (afk) wsSend({ type: 'afk', afk: true });
  };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    renderUserbar();
    setTimeout(() => S.ws === ws && connectWs(), 2000);
  };
}
const wsSend = (m: object) => S.ws?.readyState === WebSocket.OPEN && S.ws.send(JSON.stringify(m));

// Как в Discord: 10 минут не трогали мышь и клавиатуру (и не в звонке) — «в сети» становится «неактивен»
const AFK_MS = 10 * 60e3;
let afk = false;
let lastInput = Date.now();
const touched = () => {
  lastInput = Date.now();
  if (afk) { afk = false; wsSend({ type: 'afk', afk: false }); }
};
for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'focus']) window.addEventListener(ev, touched, { passive: true });
setInterval(() => {
  if (!afk && C.state === 'idle' && Date.now() - lastInput > AFK_MS) { afk = true; wsSend({ type: 'afk', afk: true }); }
}, 30e3);

function onEvent(ev: any) {
  switch (ev.type) {
    case 'message': {
      const m: Msg = ev.msg;
      const key = msgKey(m);
      if (S.msgs.has(key)) S.msgs.get(key)!.push(m);
      if (convKey() === key) renderMessages();
      else if (m.sender !== S.me!.id) { S.unread.set(key, (S.unread.get(key) || 0) + 1); renderFriends(); }
      // как в Discord: молчим про открытую беседу, пока окно в фокусе, и в «Не беспокоить»
      if (m.sender !== S.me!.id && !m.kind && S.me!.status !== 'dnd' && !(convKey() === key && document.hasFocus())) sfx('message');
      break;
    }
    case 'friends': loadFriends(); break;
    case 'groups': loadGroups().catch(() => {}); break;
    case 'presence': {
      mergeUser({ id: ev.userId, online: ev.online, status: ev.status } as User);
      renderFriends();
      break;
    }
    // кто-то из друзей или участников групп поменял профиль
    case 'user':
      mergeUser(ev.user);
      renderFriends();
      renderMessages();
      if (C.state !== 'idle') renderPeople();
      break;
    // свой профиль или статус поменяли (в том числе на другом устройстве)
    case 'me':
      Object.assign(S.me!, ev.user);
      renderMe();
      break;
    // кто сейчас в звонке группы
    case 'gcall': {
      const g = group(ev.group);
      if (!g) break;
      g.call = ev.users;
      // звонок закончился или мы ответили на другом устройстве
      if (C.incomingG === g.id && (!g.call.length || g.call.includes(S.me!.id))) closeIncoming();
      renderFriends();
      break;
    }
    case 'gcall_ring': onGroupRing(ev.group, ev.from); break;
    case 'call_invite': onIncoming(ev.from); break;
    case 'call_accept': if (C.peer?.id === ev.from.id) setCallState('incall'); break;
    case 'call_decline':
      if (C.peer?.id === ev.from.id && C.state === 'calling') { toast(`${uname(userById(ev.from.id) ?? ev.from)} отклонил(а) звонок`); hangup(false); }
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
  peer: null as User | null, // звонок другу
  gid: 0, // звонок в группе (тогда peer = null)
  state: 'idle' as 'idle' | 'calling' | 'incall',
  incoming: null as User | null,
  incomingG: 0, // нам звонят в группе
  inTimer: 0,
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

setSfxOutput(C.outId);

// беседа, в которой идёт звонок (тот же ключ, что у conv())
const callKey = () => C.gid ? 'g' + C.gid : C.peer ? 'u' + C.peer.id : '';
const callName = () => C.gid ? (group(C.gid) ? gname(group(C.gid)!) : 'Группа') : (C.peer ? uname(C.peer) : '');
const ringing = () => !!C.incoming || !!C.incomingG;

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
  // включили микрофон при отключённом звуке — звук тоже возвращается, играет его сигнал
  if (!mute && C.deaf) setDeaf(false);
  else sfx(mute ? 'mute' : 'unmute');
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
  sfx(deaf ? 'deafen' : 'undeafen');
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
async function reconnect(toRelay: boolean) {
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
    await joinRoom(carry);
  } catch (err) {
    toast('Не удалось переподключиться: ' + (err as Error).message);
    hangup(true);
  } finally {
    C.switching = false;
  }
}

// mode: 'auto' — по ситуации (VPN/обрывы -> TURN/TLS), 'all' — все пути (UDP, TCP 7881, TURN), запасной вариант
// Подключение к комнате звонка: с другом (C.peer) или в группе (C.gid)
async function joinRoom(carry?: Carry, mode: 'auto' | 'all' = 'auto') {
  const gen = C.gen;
  const peer = C.peer;
  const { url, token } = await api('/api/call/token', C.gid ? { group: C.gid } : { peer: peer!.id }, 7000, 2);
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
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      pub.track?.detach().forEach((e) => e.remove());
      if (mine() && pub.source === Track.Source.ScreenShare) sfx('streamEnd');
      renderStage();
    })
    .on(RoomEvent.TrackMuted, renderPeople)
    .on(RoomEvent.TrackUnmuted, renderPeople)
    .on(RoomEvent.ActiveSpeakersChanged, renderPeople)
    .on(RoomEvent.ParticipantConnected, () => {
      if (C.room === room) sfx('join');
      clearTimeout(C.peerGone);
      setNet('');
      setCallState('incall');
    })
    // Собеседник пропал — ждём, вдруг переподключается. Явное «Завершить» придёт через call_end
    .on(RoomEvent.ParticipantDisconnected, () => {
      if (C.room === room) sfx('leave');
      syncAudio(room);
      renderStage();
      renderPeople();
      // в группе звонок продолжается, даже если остался один
      if (!peer || room.remoteParticipants.size > 0 || C.state !== 'incall') return;
      setNet(`${uname(peer)} переподключается…`);
      clearTimeout(C.peerGone);
      C.peerGone = window.setTimeout(() => { if (mine() && room.remoteParticipants.size === 0) { toast('Собеседник отключился'); hangup(true); } }, 20000);
    })
    .on(RoomEvent.Reconnecting, () => {
      if (!mine()) return;
      setNet('связь прервалась, восстанавливаю…');
      if (relay || C.relayBroken) return;
      // UDP через VPN часто «моргает»: если сам не восстановился за 4 с или рвётся повторно — в TCP
      if (++reconnCount >= 2) return reconnect(true);
      reconnTimer = window.setTimeout(() => mine() && reconnect(true), 4000);
    })
    .on(RoomEvent.Reconnected, () => { clearTimeout(reconnTimer); if (mine()) setNet(''); })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      clearTimeout(reconnTimer);
      if (!mine()) return;
      // нас убрали из группы — сервер выкинул из комнаты
      if (C.gid && reason === DisconnectReason.PARTICIPANT_REMOVED) return hangup(false);
      if (++C.rejoins > 3) { toast('Связь потеряна'); return hangup(true); }
      reconnect(true);
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
    if (relay) { C.relayBroken = true; return joinRoom(carry, 'all'); }
    if (mode === 'all' || C.relayAuto) throw err;
    C.relayAuto = true;
    return joinRoom(carry);
  }
  if (room.remoteParticipants.size > 0) { C.state = 'incall'; setNet(''); }
  if (!carry && C.state === 'incall') sfx('connect');
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
  C.gid = 0;
  setCallState('calling');
  try {
    await joinRoom();
    wsSend({ type: 'call_invite', to: peer.id });
    C.ringTimer = window.setTimeout(() => { if (C.state === 'calling') { toast('Нет ответа'); hangup(true); } }, 30000);
  } catch (err) {
    toast('Не удалось начать звонок: ' + (err as Error).message);
    hangup(false);
  }
}

// Звонок в группе: первый вошедший (ring) звонит остальным, кто жмёт позже — просто присоединяется
async function startGroupCall(gid: number, ring: boolean) {
  if (C.state !== 'idle') return C.gid === gid || toast('Ты уже в звонке');
  if (C.incomingG === gid) closeIncoming();
  C.gid = gid;
  C.peer = null;
  setCallState('incall');
  try {
    await joinRoom();
    if (C.gid === gid) wsSend({ type: 'gcall_join', group: gid, ring });
  } catch (err) {
    toast('Не удалось подключиться к звонку: ' + (err as Error).message);
    hangup(false);
  }
}

function onGroupRing(gid: number, from: User) {
  const g = group(gid);
  if (!g) return;
  if (C.state !== 'idle' || ringing()) return toast(`${uname(userById(from.id) ?? from)} начал(а) звонок в «${gname(g)}»`);
  C.incomingG = gid;
  $('#modal').innerHTML = `
    <div class="incoming">
      <div class="in-av">${gavatar(g, 80)}</div>
      <b>${esc(gname(g))}</b><span>${esc(uname(userById(from.id) ?? from))} звонит в группе…</span>
      <div class="row">
        <button class="rbtn big red" id="dec" title="Отклонить">${ic('hangup', 26)}</button>
        <button class="rbtn big green" id="acc" title="Присоединиться">${ic('phone', 24)}</button>
      </div>
    </div>`;
  ringtone(true);
  C.inTimer = window.setTimeout(() => { if (C.incomingG === gid) closeIncoming(); }, 30000);
  $('#acc').onclick = () => {
    closeIncoming();
    openGroup(gid);
    startGroupCall(gid, false);
  };
  $('#dec').onclick = closeIncoming;
}

function onIncoming(from: User) {
  if (C.room || C.state !== 'idle') return wsSend({ type: 'call_decline', to: from.id });
  if (C.incomingG) closeIncoming(); // личный звонок важнее звонка в группе
  C.incoming = from;
  $('#modal').innerHTML = `
    <div class="incoming">
      <div class="in-av">${avatar(userById(from.id) ?? from, 80)}</div>
      <b>${esc(uname(userById(from.id) ?? from))}</b><span>Входящий звонок…</span>
      <div class="row">
        <button class="rbtn big red" id="dec" title="Отклонить">${ic('hangup', 26)}</button>
        <button class="rbtn big green" id="acc" title="Принять">${ic('phone', 24)}</button>
      </div>
    </div>`;
  ringtone(true);
  $('#acc').onclick = async () => {
    closeIncoming();
    C.peer = friend(from.id) || from;
    C.gid = 0;
    setCallState('incall');
    openChat(C.peer);
    try {
      await joinRoom();
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
  C.incomingG = 0;
  clearTimeout(C.inTimer);
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

let ringAudio: HTMLAudioElement | null = null;
async function ringtone(on: boolean, preview = false) {
  sfxLoop('ring', false);
  if (ringAudio) {
    ringAudio.pause();
    URL.revokeObjectURL(ringAudio.src);
    ringAudio = null;
  }
  // «Не беспокоить»: входящий звонок показываем, но без звука
  if (!on || (!preview && S.me?.status === 'dnd')) return;
  // своя мелодия пользователя, иначе общая мелодия сервера, иначе гудки
  const blob = (await idb<Blob>('readonly', (s) => s.get('ringtone')).catch(() => undefined))
    ?? (await idb<Blob>('readonly', (s) => s.get('serverRingtone')).catch(() => undefined));
  if (!preview && !ringing()) return; // звонок уже приняли/сбросили, пока читали файл
  if (blob) {
    const a = (ringAudio = new Audio(URL.createObjectURL(blob)));
    a.loop = true;
    a.volume = 0.7;
    return a.play().catch(() => sfxLoop('ring', true));
  }
  sfxLoop('ring', true);
}

function setCallState(s: typeof C.state) {
  C.state = s;
  if (s === 'incall') clearTimeout(C.ringTimer);
  renderCall();
}

function hangup(notify: boolean) {
  if (C.state !== 'idle') sfx('disconnect');
  C.gen++;
  clearTimeout(C.ringTimer);
  clearTimeout(C.peerGone);
  C.net = '';
  if (notify && C.peer && C.state !== 'idle') wsSend({ type: 'call_end', to: C.peer.id });
  if (C.gid) wsSend({ type: 'gcall_leave', group: C.gid });
  const room = C.room;
  C.room = null;
  C.peer = null;
  C.gid = 0;
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
    if (lp.isScreenShareEnabled) sfx('streamStart');
  } catch (err) {
    if ((err as Error).name !== 'NotAllowedError') toast('Демонстрация не запустилась: ' + (err as Error).message);
  }
  renderCall();
}

// Панель звонка видна только в беседе, где идёт звонок
function syncCallBox() {
  const box = document.getElementById('call');
  if (box) box.hidden = C.state === 'idle' || !callKey() || convKey() !== callKey();
}

function renderCall() {
  sfxLoop('calling', C.state === 'calling');
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
  if (C.state === 'idle' || !callKey()) { vb.hidden = true; vb.innerHTML = ''; return; }
  const scr = C.room?.localParticipant.isScreenShareEnabled ?? false;
  const st = C.state === 'calling' ? ['wait', 'Вызов…'] : C.net ? ['warn', 'Восстанавливаю связь'] : !C.room ? ['wait', 'Подключение…'] : ['', 'Голос подключён'];
  vb.hidden = false;
  vb.innerHTML = `
    <div class="vb-row">
      <div class="vb-info" data-act="${C.gid ? 'gopen' : 'open'}" data-id="${C.gid || C.peer!.id}" title="Открыть беседу">
        <div class="vb-st ${st[0]}">${ic('signal', 16)}${st[1]}</div>
        <div class="vb-peer">${esc(callName())}${C.relay || C.relayAuto || C.vpn ? ' • TCP' : ''}</div>
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
    const u = userById(Number(p.identity)) ?? { id: Number(p.identity), username: p.name || p.identity };
    return `<div class="pp ${p.isSpeaking ? 'speak' : ''}" title="${esc(uname(u))}" data-act="user" data-id="${u.id}">${avatar(u, 80)}${
      p.isMicrophoneEnabled ? '' : `<span class="pp-mute">${ic('micOff', 14)}</span>`}</div>`;
  }).join('');
  // собеседник ещё не подключился — показываем его аватарку с пульсацией
  if (C.peer && !room?.remoteParticipants.size) html += `<div class="pp wait" title="${esc(uname(C.peer))}">${avatar(C.peer, 80)}</div>`;
  box.innerHTML = html;
}

// ---------- настройки ----------
type SetTab = 'account' | 'profile' | 'voice' | 'sounds';
let setTab: SetTab = 'account';
let ringPreview = false;
let micTest: { stream: MediaStream; ctx: AudioContext; audio: HTMLAudioElement; raf: number } | null = null;

function openSettings(tab: SetTab) {
  if (!S.me) return;
  if (setTab !== tab && profDirty()) return shakeSavebar();
  setTab = tab;
  const navBtn = (t: SetTab, title: string) => `<button class="sn ${setTab === t ? 'sel' : ''}" data-set="${t}">${title}</button>`;
  $('#layer').innerHTML = `
    <div class="settings">
      <nav class="set-nav"><div class="set-nav-in">
        <div class="set-me">${avatar(S.me, 40)}<div><b>${esc(uname(S.me))}</b><span>Startrack ${__APP_VERSION__}</span></div></div>
        <h5>Настройки пользователя</h5>
        ${navBtn('account', 'Моя учётная запись')}
        ${navBtn('profile', 'Профиль')}
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
    if (t === 'logout') return profDirty() ? shakeSavebar() : logout();
    openSettings(t as SetTab);
  };
  renderSettingsTab();
}

// force — закрыть, даже если в профиле есть несохранённые изменения (выход из аккаунта)
function closeSettings(force = false) {
  if (!force && profDirty()) return shakeSavebar();
  dropDraft();
  stopMicTest();
  if (ringPreview && !ringing()) ringtone(false);
  ringPreview = false;
  $('#layer').innerHTML = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.pop')) closePop();
  else if (document.querySelector('.lightbox')) closeViewer();
  else if (document.querySelector('.dlg-bg')) closeDlg();
  else if (document.querySelector('.settings')) closeSettings();
});

function renderSettingsTab() {
  stopMicTest();
  const box = document.getElementById('setc');
  if (!box || !S.me) return;
  const me = S.me;
  if (setTab === 'profile') return renderProfileEditor(box);
  if (setTab === 'account') {
    box.innerHTML = `
      <h2>Моя учётная запись</h2>
      <div class="acct">
        <div class="acct-banner" style="${bannerStyle(me)}"></div>
        <div class="acct-head">${avatar(me, 80, true)}<b>${esc(uname(me))}</b><button class="btn" data-set="profile">Редактировать профиль</button></div>
        <div class="acct-box">
          <div class="acct-f"><h4>Отображаемое имя</h4><span>${esc(me.display || 'Не задано')}</span></div>
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
          <span>${name ? 'Своя мелодия — хранится на этом компьютере' : server ? 'Общая мелодия, загружена с сервера' : 'Мелодия Startrack'}</span></div>
        <button class="rbtn" id="rplay" title="Прослушать">${ic(ringPreview ? 'stop' : 'play')}</button>
      </div>
      <div class="row">
        <button class="btn" id="rpick">Выбрать файл…</button>
        <button class="btn sec" id="rdef" ${name ? '' : 'disabled'}>По умолчанию</button>
      </div>
      <input type="file" id="rfile" accept="audio/*" hidden>
      <hr>
      <h3>Звуки приложения</h3>
      <label class="fld sfx-vol"><span>Громкость звуков</span><input type="range" id="sfxvol" min="0" max="100" value="${Math.round(sfxVol * 100)}"></label>
      ${(Object.keys(SFX_GROUPS) as SfxGroup[]).map((g) => `
        <div class="switch-row sfx-row"><div><b>${SFX_GROUPS[g].title}</b><span>${SFX_GROUPS[g].hint}</span></div>
          <button class="rbtn" data-sfx="${g}" title="Прослушать">${ic('play')}</button>
          <input type="checkbox" class="switch" data-sfxon="${g}" ${sfxOn(g) ? 'checked' : ''}></div>`).join('')}`;
    $<HTMLInputElement>('#sfxvol').onchange = (e) => { setSfxVol(Number((e.target as HTMLInputElement).value) / 100); sfx('message', true); };
    box.querySelectorAll<HTMLElement>('[data-sfx]').forEach((b) => (b.onclick = () => {
      const all = SFX_GROUPS[b.dataset.sfx as SfxGroup].sounds;
      all.forEach((x, i) => setTimeout(() => sfx(x, true), i * 700));
    }));
    box.querySelectorAll<HTMLInputElement>('[data-sfxon]').forEach((c) => (c.onchange = () => setSfxOn(c.dataset.sfxon as SfxGroup, c.checked)));
    $('#rplay').onclick = () => {
      if (ringing()) return;
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
      if (!ringing()) ringtone(false);
      ringPreview = false;
      renderSettingsTab();
    };
    $('#rdef').onclick = async () => {
      await idb('readwrite', (s) => s.delete('ringtone'));
      store.set('ringName', '');
      toast(store.get('srvRingVer') ? 'Мелодия сервера' : 'Стандартная мелодия');
      if (!ringing()) ringtone(false);
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
    if (on && C.room) { setRelay(true); return reconnect(true); }
    setRelay(on);
    if (C.room) toast('Применится со следующего звонка');
  };
  $('#smt').onclick = () => (micTest ? stopMicTest() : startMicTest());
  fillDevices();
}

// ---------- редактор профиля ----------
// Черновик: что поменяли, но ещё не сохранили. Картинка: { blob, url } — новая, null — убрать, undefined — как было
type Img = { blob: Blob; url: string } | null | undefined;
type Draft = { display: string; pronouns: string; bio: string; custom: string; bcolor: string; avatar: Img; banner: Img };
let draft: Draft | null = null;
const BANNER_COLORS = ['', '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c', '#2b2d31'];
const TEXT_FIELDS = ['display', 'pronouns', 'bio', 'custom', 'bcolor'] as const;

const newDraft = (): Draft => ({ ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, S.me![k] || ''])) as Pick<Draft, typeof TEXT_FIELDS[number]>, avatar: undefined, banner: undefined });
function dropDraft() {
  for (const img of [draft?.avatar, draft?.banner]) if (img) URL.revokeObjectURL(img.url);
  draft = null;
}
const profDirty = () => !!draft && !!S.me && (draft.avatar !== undefined || draft.banner !== undefined
  || TEXT_FIELDS.some((k) => draft![k] !== (S.me![k] || '')));
function shakeSavebar() {
  const bar = document.querySelector<HTMLElement>('.savebar');
  if (!bar) return;
  bar.classList.remove('shake');
  void bar.offsetWidth; // перезапуск анимации
  bar.classList.add('shake');
}

// Как будет выглядеть профиль после сохранения
function draftUser(): User {
  const d = draft!;
  const img = (i: Img, cur?: string) => i === undefined ? cur : i?.url ?? '';
  return { ...S.me!, display: d.display.trim(), pronouns: d.pronouns.trim(), bio: d.bio.trim(), custom: d.custom.trim(), bcolor: d.bcolor,
    avatar: img(d.avatar, S.me!.avatar), banner: img(d.banner, S.me!.banner) };
}
function drawPreview() {
  const box = document.getElementById('pf-preview');
  if (!box || !draft) return;
  const u = draftUser();
  box.innerHTML = cardHtml(u, 'preview', infoHtml(u) + '<div class="pc-btns"><button class="btn" tabindex="-1">Пример кнопки</button></div>');
  const bar = document.querySelector<HTMLElement>('.savebar')!;
  bar.hidden = !profDirty();
  document.querySelectorAll<HTMLElement>('.pfe-sw').forEach((s) => s.classList.toggle('on', s.dataset.c === draft!.bcolor));
  $<HTMLButtonElement>('#pf-avdel').disabled = !u.avatar;
  $<HTMLButtonElement>('#pf-bndel').disabled = !u.banner;
  $('#pf-bio-n').textContent = String(190 - draft.bio.length);
}

function renderProfileEditor(box: HTMLElement) {
  draft ??= newDraft();
  const d = draft;
  const me = S.me!;
  box.innerHTML = `
    <h2>Профиль</h2>
    <div class="pfe" id="pfedit">
      <div class="pfe-form">
        <label class="fld"><span>Отображаемое имя</span><input id="pf-display" maxlength="32" placeholder="${esc(me.username)}" spellcheck="false"></label>
        <label class="fld"><span>Местоимения</span><input id="pf-pronouns" maxlength="40" placeholder="Добавьте местоимения" spellcheck="false"></label>
        <hr>
        <div class="fld"><span>Аватар</span>
          <div class="row"><button class="btn" id="pf-av">Сменить аватар</button><button class="btn lnk" id="pf-avdel">Удалить аватар</button></div></div>
        <hr>
        <div class="fld"><span>Баннер профиля</span>
          <div class="row"><button class="btn" id="pf-bn">${ic('image', 18)}Загрузить картинку</button><button class="btn lnk" id="pf-bndel">Убрать картинку</button></div></div>
        <div class="fld"><span>Цвет баннера</span>
          <div class="pfe-colors">${BANNER_COLORS.map((c) => `<button class="pfe-sw ${c ? '' : 'auto'}" data-c="${c}" style="background:${c || avColor(me.id)}" title="${c ? c : 'По умолчанию'}"></button>`).join('')}
            <label class="pfe-sw pick" title="Свой цвет">${ic('edit', 16)}<input type="color" id="pf-color"></label></div></div>
        <hr>
        <div class="fld"><span>Свой статус</span>
          <div class="cst-in"><input id="pf-custom" maxlength="128" placeholder="Чем заняты?" spellcheck="false"><button type="button" class="emo-btn" title="Выбрать эмодзи"><span class="emo">${EMO_BTN[0]}</span></button></div></div>
        <div class="fld"><span>Обо мне</span>
          <p class="set-hint">Пара слов о себе — увидят все, кто откроет ваш профиль.</p>
          <div class="pfe-bio"><textarea id="pf-bio" maxlength="190" rows="4" placeholder="Опишите себя в трёх эмодзи"></textarea>
            <button type="button" class="emo-btn" title="Выбрать эмодзи"><span class="emo">${EMO_BTN[0]}</span></button><small id="pf-bio-n"></small></div></div>
      </div>
      <div class="pfe-prev"><h5>Предпросмотр</h5><div id="pf-preview"></div></div>
    </div>
    <input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    <div class="savebar" hidden><span>Осторожно — у вас есть несохранённые изменения!</span>
      <button class="btn lnk" id="pf-reset">Сбросить</button><button class="btn green" id="pf-save">Сохранить изменения</button></div>`;
  for (const k of ['display', 'pronouns', 'custom', 'bio'] as const) {
    const el = $<HTMLInputElement>('#pf-' + k);
    el.value = d[k];
    el.addEventListener('input', () => { d[k] = el.value; drawPreview(); });
  }
  bindEmoji($<HTMLInputElement>('#pf-custom'), $('.cst-in .emo-btn', box));
  bindEmoji($<HTMLTextAreaElement>('#pf-bio'), $('.pfe-bio .emo-btn', box));
  box.querySelectorAll<HTMLElement>('.pfe-sw[data-c]').forEach((s) => (s.onclick = () => { d.bcolor = s.dataset.c!; drawPreview(); }));
  const color = $<HTMLInputElement>('#pf-color');
  color.value = d.bcolor || avColor(me.id);
  color.oninput = () => { d.bcolor = color.value; drawPreview(); };
  // картинки: выбрать файл -> обрезать -> в черновик
  const file = $<HTMLInputElement>('#pf-file');
  let kind: 'avatar' | 'banner' = 'avatar';
  const setImg = (k: 'avatar' | 'banner', img: Img) => {
    const old = d[k];
    if (old) URL.revokeObjectURL(old.url);
    d[k] = img === null && !me[k] ? undefined : img; // убрать то, чего и не было, — не изменение
    drawPreview();
  };
  $('#pf-av').onclick = () => { kind = 'avatar'; file.click(); };
  $('#pf-bn').onclick = () => { kind = 'banner'; file.click(); };
  $('#pf-avdel').onclick = () => setImg('avatar', null);
  $('#pf-bndel').onclick = () => setImg('banner', null);
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const blob = await cropImage(f, kind);
    if (blob) setImg(kind, { blob, url: URL.createObjectURL(blob) });
  };
  $('#pf-reset').onclick = () => { dropDraft(); renderSettingsTab(); };
  $('#pf-save').onclick = saveProfile;
  drawPreview();
}

async function uploadImage(blob: Blob, kind: 'avatar' | 'banner') {
  let r: Response;
  try {
    r = await fetch(`${S.server}/api/me/image?kind=${kind}`, {
      method: 'POST', body: blob, signal: AbortSignal.timeout(120000),
      headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': blob.type },
    });
  } catch { throw new Error('Не удалось загрузить картинку: нет связи с сервером'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить картинку: HTTP ' + r.status);
  return data as User;
}

async function saveProfile() {
  const d = draft;
  const btn = document.querySelector<HTMLButtonElement>('#pf-save');
  if (!d || !btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    for (const k of ['avatar', 'banner'] as const) {
      const img = d[k];
      if (img) { Object.assign(S.me!, await uploadImage(img.blob, k)); URL.revokeObjectURL(img.url); d[k] = undefined; }
    }
    const body: Record<string, unknown> = Object.fromEntries(TEXT_FIELDS.map((k) => [k, d[k]]));
    for (const k of ['avatar', 'banner'] as const) if (d[k] === null) body[k] = null;
    Object.assign(S.me!, await api('/api/me/profile', body));
    dropDraft();
    renderMe();
    openSettings('profile');
    toast('Профиль сохранён');
  } catch (err) {
    toast((err as Error).message);
    btn.disabled = false;
    btn.textContent = 'Сохранить изменения';
    drawPreview();
  }
}

// Обрезка картинки, как в Discord: двигаем мышью, масштаб — ползунком или колесом.
// Аватарка — квадрат 512×512 (показывается кругом), баннер — 1500×600. GIF отправляем как есть, чтобы не пропала анимация.
const CROP = { avatar: { w: 300, h: 300, ow: 512, oh: 512 }, banner: { w: 480, h: 192, ow: 1500, oh: 600 } };
async function cropImage(file: File, kind: 'avatar' | 'banner'): Promise<Blob | null> {
  if (!/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.type)) { toast('Нужна картинка: PNG, JPEG, WebP или GIF'); return null; }
  if (file.type === 'image/gif') {
    if (file.size <= 8 * 1048576) return file;
    toast('GIF больше 8 МБ'); return null;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  const ok = await new Promise<boolean>((r) => { img.onload = () => r(true); img.onerror = () => r(false); img.src = url; });
  if (!ok || !img.naturalWidth) { URL.revokeObjectURL(url); toast('Не удалось открыть картинку'); return null; }
  const c = CROP[kind];
  return new Promise((resolve) => {
    const bg = showDlg('crop', `
      <h3>Изменить изображение</h3>
      <div class="crop-box ${kind}" style="width:${c.w}px;height:${c.h}px"><canvas></canvas><div class="crop-mask"></div></div>
      <div class="crop-zoom">${ic('image', 16)}<input type="range" min="1" max="4" step="0.01" value="1">${ic('image', 24)}</div>
      <div class="dlg-btns"><button class="btn lnk" data-r="reset">Сбросить</button><span class="grow"></span><button class="btn sec" data-r="0">Отмена</button><button class="btn" data-r="1">Применить</button></div>`);
    const cv = $<HTMLCanvasElement>('canvas', bg);
    const zoomEl = $<HTMLInputElement>('input', bg);
    const dpr = devicePixelRatio || 1;
    cv.width = c.w * dpr;
    cv.height = c.h * dpr;
    const base = Math.max(c.w / img.naturalWidth, c.h / img.naturalHeight); // «cover»: картинка всегда закрывает рамку
    let zoom = 1, x = 0, y = 0; // сдвиг центра картинки от центра рамки, в пикселях рамки
    const clamp = () => {
      const w = img.naturalWidth * base * zoom, h = img.naturalHeight * base * zoom;
      x = Math.max(-(w - c.w) / 2, Math.min((w - c.w) / 2, x));
      y = Math.max(-(h - c.h) / 2, Math.min((h - c.h) / 2, y));
    };
    const paint = (ctx: CanvasRenderingContext2D, k: number) => {
      const s = base * zoom * k;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (c.w * k) / 2 + x * k - (img.naturalWidth * s) / 2, (c.h * k) / 2 + y * k - (img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    };
    const draw = () => {
      clamp();
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, cv.width, cv.height);
      paint(ctx, dpr);
    };
    const setZoom = (z: number) => { zoom = Math.max(1, Math.min(4, z)); zoomEl.value = String(zoom); draw(); };
    zoomEl.oninput = () => setZoom(Number(zoomEl.value));
    cv.onwheel = (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); };
    cv.onpointerdown = (e) => {
      cv.setPointerCapture(e.pointerId);
      const sx = e.clientX - x, sy = e.clientY - y;
      cv.onpointermove = (m) => { x = m.clientX - sx; y = m.clientY - sy; draw(); };
      cv.onpointerup = () => { cv.onpointermove = null; };
    };
    draw();
    let done = false;
    const finish = (b: Blob | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(b);
      closeDlg();
    };
    new MutationObserver((_, o) => { if (!bg.isConnected) { o.disconnect(); finish(null); } }).observe(document.body, { childList: true });
    $('[data-r="0"]', bg).onclick = () => finish(null);
    $('[data-r="reset"]', bg).onclick = () => { x = 0; y = 0; setZoom(1); };
    $('[data-r="1"]', bg).onclick = () => {
      const out = document.createElement('canvas');
      out.width = c.ow;
      out.height = c.oh;
      paint(out.getContext('2d')!, c.ow / c.w);
      out.toBlob((b) => b ? finish(b) : out.toBlob(finish, 'image/png'), 'image/webp', 0.9);
    };
  });
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
      if (key === 'outId') setSfxOutput(el.value);
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

// ---------- обновления ----------
// Как в Discord: при запуске проверяем релиз на GitHub; есть новее — сразу скачиваем и ставим.
// Не успели проверить за несколько секунд — пускаем в приложение, а найденное обновление
// покажем зелёной кнопкой в левой панели. Пока приложение открыто, проверяем каждые 3 минуты
// и когда окно снова в фокусе; проверка не прошла (сеть, VPN) — повторяем через минуту.
const tauri = (window as any).__TAURI_INTERNALS__;
const U = { version: '', notes: '' };
let updTimer = 0;
let updBusy = false;
let updLast = 0;

// Скачанный файл: приложение (download.rs) сообщает, куда его сохранило
(window as any).__stDownload = (path: string | null, ok: boolean) => {
  if (!ok || !path) return toast('Не удалось скачать файл');
  toast(`Сохранено в «Загрузки»: ${path.split(/[\\/]/).pop()} — нажмите, чтобы показать в папке`,
    () => tauri.invoke('reveal_file', { path }).catch(() => {}));
};

async function checkUpdate() {
  if (!tauri || import.meta.env.DEV || U.version || updBusy) return !!U.version;
  updBusy = true;
  updLast = Date.now();
  clearTimeout(updTimer);
  let ok = false;
  try {
    const r: [string, string] | null = await tauri.invoke('update_check');
    ok = true;
    if (r) { [U.version, U.notes] = r; renderRail(); }
  } catch {}
  updBusy = false;
  if (!U.version) updTimer = window.setTimeout(checkUpdate, ok ? 3 * 60e3 : 60e3);
  return !!U.version;
}
window.addEventListener('focus', () => { if (Date.now() - updLast > 60e3) checkUpdate(); });

const bootScreen = (body: string) => `<div class="auth-bg"><div class="boot">${ic('logo', 64)}${body}</div></div>`;
const mb = (n: number) => (n / 1048576).toFixed(1);

// Скачивает и ставит обновление; box — куда рисовать экран загрузки. onSkip — что делать, если отказались.
async function installUpdate(box: HTMLElement, onSkip = () => { box.innerHTML = ''; }) {
  box.innerHTML = bootScreen(`
    <div class="upd-box">
      <b>Загрузка обновления ${esc(U.version)}</b>
      <div class="upd-bar"><i></i></div>
      <span class="upd-txt">Подключаюсь…</span>
    </div>`);
  const bar = $('.upd-bar i', box);
  const txt = $('.upd-txt', box);
  const timer = setInterval(async () => {
    const [done, total]: [number, number] = await tauri.invoke('update_progress').catch(() => [0, 0]);
    if (!done) return;
    if (total) bar.style.width = `${Math.min(100, (done / total) * 100)}%`;
    txt.textContent = done >= total && total ? 'Устанавливаю…' : `${mb(done)}${total ? ' из ' + mb(total) : ''} МБ`;
  }, 200);
  try {
    // при успехе приложение закрывается, установщик ставит новую версию и запускает её
    await tauri.invoke('update_install');
  } catch (err) {
    clearInterval(timer);
    box.innerHTML = bootScreen(`
      <div class="upd-box">
        <b>Не удалось обновиться</b>
        <span class="err">${esc(String(err))}</span>
        <div class="upd-btns"><button class="btn" id="updRetry">Повторить</button><button class="btn sec" id="updSkip">Пропустить</button></div>
      </div>`);
    $('#updRetry', box).onclick = () => installUpdate(box, onSkip);
    $('#updSkip', box).onclick = onSkip;
  }
}

// ---------- boot ----------
function enter() {
  if (S.token) {
    $('#root').innerHTML = bootScreen('<div class="status"><span class="spin"></span>Подключаюсь к серверу…</div>');
    api('/api/me').then(start).catch((err) =>
      renderAuth(err instanceof NetError ? `${err.message} ${NET_HINT}` : 'Сессия истекла, войдите заново.'));
  }
  else renderAuth();
}

(async () => {
  if (tauri && !import.meta.env.DEV) {
    $('#root').innerHTML = bootScreen('<div class="status"><span class="spin"></span>Проверка обновлений…</div>');
    const found = await Promise.race([checkUpdate(), new Promise<boolean>((r) => setTimeout(() => r(false), 6000))]);
    if (found) return installUpdate($('#root'), enter);
  }
  enter();
})();

// только для тестов в dev-сборке
if (import.meta.env.DEV) (window as any).__st = { C, S, reconnect, onIncoming, ringPlaying: () => !!ringAudio && !ringAudio.paused };
