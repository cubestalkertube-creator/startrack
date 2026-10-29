// Верити™ — ИИ-помощник (жёлтый смайлик из сериала по Minecraft). Отвечает нейросеть на сервере,
// здесь — его лица, отдельная беседа в списке «Личные сообщения» и наказания, когда его разозлили.
// Лицо молча меняется по злости, которую считает сервер (grin → smile → neutral → annoyed → angry → furious).
// Никаких подписей настроения и шкал пользователю не показываем — он сам замечает, что Верити закипает.
// Включается/выключается в Настройках (O.isEnabled); по умолчанию выключен.
// В приложении для ПК у него есть руки (O.pc): файлы, команды, программы, запуск кода — сервер просит
// действие, приложение выполняет (и спрашивает разрешение нативным окном, см. src-tauri/src/verity.rs).

export type Face = 'grin' | 'smile' | 'neutral' | 'annoyed' | 'angry' | 'furious' | 'think';
type Step = { k: string; t: string; ok: boolean; out?: string }; // что Верити сделал по ходу ответа
type Call = { id: string; name: string; args: unknown; label: string }; // действие на компьютере, которое просит сервер
type VMsg = {
  id: number; role: 'user' | 'verity'; text: string; face: Face | null; prank: string | null; created: number;
  steps?: Step[]; imgs?: string[]; files?: string[]; // imgs/files — только у своих, ещё не перечитанных с сервера
};
type Att = { kind: 'image' | 'video' | 'audio' | 'pdf' | 'text'; name: string; size: number; thumb?: string; data?: string; frames?: string[]; text?: string };

type Opts = {
  api(path: string, body?: unknown, timeoutMs?: number): Promise<any>;
  toast(text: string): void;
  esc(s: string): string;
  ic(name: string, size?: number): string;
  emojify(s: string): string;
  linkify(html: string): string;
  stamp(t: number): string;
  me(): { name: string; avatar: (size: number) => string };
  setTheme(id: string | null): void; // null — вернуть тему пользователя
  os(): string;
  back: string; // кнопка «Назад» для телефона
  isEnabled?: () => boolean; // чат-бот включён в настройках
  pc?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<any> } | null; // Tauri на ПК: руки Верити
  hasPersonality?: () => boolean; // включена ли личность
  setPersonality?: (on: boolean) => void;
};

// Чат с Верити, как в ChatGPT: их несколько, и пока в одном Верити работает, можно писать в другом.
// id 0 — новый чат, которого на сервере ещё нет (появится с первым сообщением).
type Chat = {
  id: number; title: string; updated: number;
  msgs: VMsg[]; loaded: boolean;
  busy: boolean; stop: boolean;
  live: { steps: Step[]; now: string } | null; // ход в работе: сделанные шаги и текущее действие
};
const newChat = (c?: { id: number; title: string; updated: number }): Chat =>
  ({ id: c?.id ?? 0, title: c?.title ?? '', updated: c?.updated ?? Date.now(), msgs: [], loaded: !c, busy: false, stop: false, live: null });

let O: Opts;
const V = {
  open: false,
  listed: false, // список чатов загружен
  loading: false,
  chats: [] as Chat[], // сохранённые чаты, свежие сверху
  cur: newChat(), // открытый чат
  face: 'grin' as Face,
  att: [] as Att[], // вложения, ждущие отправки
  showSide: true,
  pc: null as { mode: PcMode; workspace: string } | null,
  outs: new Map<string, string>(), // вывод блоков кода, запущенных кнопкой
};
const started = Date.now();
const enabled = () => !O?.isEnabled || O.isEnabled();
const hasPersonality = () => !O?.hasPersonality || O.hasPersonality();

export function initVerity(o: Opts) { O = o; }
export const verityOpen = () => V.open;
export function closeVerity() { V.open = false; }
export function resetVerity() {
  Object.assign(V, { open: false, listed: false, loading: false, chats: [], cur: newChat(), face: 'grin', att: [] });
  V.outs.clear();
  stopPranks();
}

// ---------- лица ----------
const INK = '#1a1a1a';
let gradSeq = 0;
// глаза в отдельной группе — наказание «watch» поворачивает их за курсором
const eyes = (body: string) => `<g class="v-eyes">${body}</g>`;
const oval = (x: number, y: number, rx: number, ry: number, fill = INK) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
const line = (d: string, w = 3.2) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
// рот с зубами: белая форма, обрезанные по ней вертикальные щели и линия между челюстями
function teeth(id: string, shape: string, mid: string, x0: number, x1: number, step: number) {
  const cuts = [];
  for (let x = x0; x <= x1; x += step) cuts.push(`M${x} 40 V100`);
  return `<clipPath id="${id}m"><path d="${shape}"/></clipPath>
    <path d="${shape}" fill="#fff"/>
    <g clip-path="url(#${id}m)">${line(cuts.join(' '), 1.3)}${line(mid, 1.5)}</g>
    <path d="${shape}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>`;
}

function features(f: Face, id: string) {
  switch (f) {
    case 'grin':
      return eyes(oval(38, 38, 4.4, 8) + oval(62, 38, 4.4, 8))
        + teeth(id, 'M23 55 Q50 92 77 55 Q50 62 23 55 Z', 'M25 59 Q50 76 75 59', 29, 71, 6);
    case 'neutral':
      return eyes(oval(38, 40, 4.2, 7) + oval(62, 40, 4.2, 7)) + line('M34 66 L66 66');
    case 'annoyed':
      return eyes(oval(38, 43, 4.2, 5.5) + oval(62, 43, 4.2, 5.5))
        + line('M29 30 L46 35 M71 30 L54 35') + line('M33 71 Q50 61 67 71');
    case 'angry':
      return `<circle cx="27" cy="58" r="7" fill="#ff3b1f" opacity=".22"/><circle cx="73" cy="58" r="7" fill="#ff3b1f" opacity=".22"/>`
        + eyes(oval(38, 44, 4.4, 4.8) + oval(62, 44, 4.4, 4.8))
        + line('M27 28 L47 37 M73 28 L53 37', 4)
        + teeth(id, 'M30 61 Q30 58 33 58 L67 58 Q70 58 70 61 L70 70 Q70 73 67 73 L33 73 Q30 73 30 70 Z', 'M30 65.5 L70 65.5', 36, 64, 7);
    case 'furious':
      return eyes(oval(35, 37, 7.8, 11) + oval(65, 38, 6.6, 9.4) + oval(35, 39, 1.5, 1.8, '#ff2020') + oval(64, 40, 1.3, 1.6, '#ff2020'))
        + teeth(id, 'M13 49 Q50 106 87 49 Q50 63 13 49 Z', 'M16 54 Q50 80 84 54', 19, 81, 5.2);
    case 'think':
      return eyes(oval(42, 35, 4.2, 7.5) + oval(66, 35, 4.2, 7.5)) + line('M42 66 Q50 70 58 66');
    default:
      return eyes(oval(38, 40, 4.2, 7.5) + oval(62, 40, 4.2, 7.5))
        + line('M27 60 Q50 80 73 60') + line('M24.5 57.5 L28 61 M75.5 57.5 L72 61', 2.6);
  }
}

export function verityFace(f: Face, size: number, cls = '') {
  const id = 'vf' + ++gradSeq;
  const hot = f === 'furious' || f === 'angry';
  const [c1, c2, c3] = f === 'furious' ? ['#ffd24a', '#ec8a14', '#7a2405'] : hot ? ['#fff07a', '#f5b800', '#a85f00'] : ['#fff7a0', '#f7d000', '#b88a00'];
  return `<svg class="v-face f-${f} ${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="Верити">
    <defs><radialGradient id="${id}" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="${c1}"/><stop offset=".55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></radialGradient></defs>
    <circle cx="50" cy="50" r="48" fill="url(#${id})"/>
    <ellipse cx="33" cy="20" rx="13" ry="6.5" fill="#fff" opacity=".35" transform="rotate(-28 33 20)"/>
    ${features(f, id)}
  </svg>`;
}

export function aiAvatar(size: number, cls = '') {
  const id = 'vai' + ++gradSeq;
  return `<svg class="v-ai-avatar ${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="ИИ-помощник">
    <defs>
      <linearGradient id="${id}g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#5865F2"/>
        <stop offset="50%" stop-color="#7c3aed"/>
        <stop offset="100%" stop-color="#ec4899"/>
      </linearGradient>
      <radialGradient id="${id}r" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="50" cy="50" r="48" fill="url(#${id}g)"/>
    <circle cx="50" cy="50" r="48" fill="url(#${id}r)"/>
    <path d="M50 20 C50 36 36 50 20 50 C36 50 50 64 50 80 C50 64 64 50 80 50 C64 50 50 36 50 20 Z" fill="#ffffff"/>
    <path d="M72 24 C72 29 67 34 62 34 C67 34 72 39 72 44 C72 39 77 34 82 34 C77 34 72 29 72 24 Z" fill="#ffffff" opacity="0.9"/>
  </svg>`;
}

// ---------- список бесед ----------
export function verityRow(filter: string) {
  if (!enabled()) return '';
  const pers = hasPersonality();
  if (filter) {
    const f = filter.toLowerCase();
    const matchNeutral = 'помощник ии assistant ai'.includes(f);
    const matchPers = pers && 'верити verity'.includes(f);
    if (!matchNeutral && !matchPers) return '';
  }
  const av = pers ? verityFace(V.face, 32) : aiAvatar(32);
  const name = pers ? 'Верити™' : 'ИИ-помощник';
  const tagClass = pers ? 'v-tag' : 'v-tag v-tag-calm';
  const sub = pers ? 'Помощник Startrack' : 'Умный ассистент';
  return `
    <div class="dm v-dm ${V.open ? 'sel' : ''}" data-act="verity">
      <span class="v-av">${av}</span>
      <div class="dm-n"><span>${name}<i class="${tagClass}">ИИ</i></span><small>${sub}</small></div>
    </div>`;
}

// ---------- беседа ----------
export async function openVerity() {
  if (!enabled()) return;
  V.open = true;
  if (matchMedia('(max-width: 760px)').matches) V.showSide = false; // на телефоне панель закрыла бы весь чат
  pcInfo();
  if (!V.listed && !V.loading) {
    V.loading = true;
    try {
      // без ?chat сервер отдаёт список чатов и переписку последнего
      const r = await O.api('/api/verity');
      mergeChats(r.chats);
      // открытый сейчас чат (в том числе работающий) не подменяем
      if (!V.cur.id && !V.cur.msgs.length && r.chat) V.cur = V.chats.find((c) => c.id === r.chat) ?? V.cur;
      const c = V.chats.find((x) => x.id === r.chat);
      if (c && !c.busy) { c.msgs = r.messages; c.loaded = true; }
      setFace(r.face);
      V.listed = true;
    } catch (err) { O.toast((err as Error).message); }
    V.loading = false;
    if (V.open) { drawMsgs(); drawSide(); }
  }
}

// список чатов с сервера; уже открытые объекты чатов оставляем (в них может идти работа)
function mergeChats(list: { id: number; title: string; updated: number }[]) {
  const old = new Map(V.chats.map((c) => [c.id, c]));
  V.chats = list.map((x) => {
    const c = old.get(x.id);
    if (!c) return newChat(x);
    Object.assign(c, { title: x.title, updated: x.updated });
    if (!c.busy) c.loaded = false; // переписку перечитаем при открытии
    return c;
  });
  // работающий чат, которого вдруг нет в списке, не теряем
  for (const c of old.values()) if (c.busy && !V.chats.includes(c)) V.chats.unshift(c);
}

async function loadChat(c: Chat) {
  if (c.loaded || !c.id) return;
  try {
    const r = await O.api('/api/verity?chat=' + c.id);
    if (!c.busy) c.msgs = r.messages;
    c.loaded = true;
  } catch (err) { O.toast((err as Error).message); }
  if (V.cur === c) drawMsgs();
}

// переключиться на чат (0 — новый пустой)
export function openVerityChat(id: number) {
  if (!id) {
    if (V.cur.id || V.cur.msgs.length) V.cur = newChat();
  } else {
    const c = V.chats.find((x) => x.id === id);
    if (!c) return;
    V.cur = c;
    loadChat(c);
  }
  V.outs.clear();
  drawMsgs();
  drawSide();
  drawTop();
  document.querySelector<HTMLTextAreaElement>('#vchat textarea')?.focus();
  if (matchMedia('(max-width: 760px)').matches && V.showSide) toggleVeritySide();
}

export async function deleteVerityChat(id: number) {
  const c = V.chats.find((x) => x.id === id);
  if (!c) return;
  try {
    const r = await O.api('/api/verity/chats/delete', { chat: id });
    c.stop = true;
    mergeChats(r.chats);
    if (V.cur === c) V.cur = V.chats[0] ?? newChat();
    loadChat(V.cur);
    drawMsgs();
    drawSide();
    drawTop();
  } catch (err) { O.toast((err as Error).message); }
}

export async function renameVerityChat(id: number) {
  const c = V.chats.find((x) => x.id === id);
  if (!c) return;
  const title = prompt('Название чата', c.title)?.trim();
  if (!title || title === c.title) return;
  try {
    const r = await O.api('/api/verity/chats/rename', { chat: id, title });
    c.title = r.title;
    drawSide();
    drawTop();
  } catch (err) { O.toast((err as Error).message); }
}

// лицо молча обновляем везде, где оно есть; ни подписей, ни шкал
function setFace(face: Face) {
  const was = V.face;
  V.face = face;
  const pers = hasPersonality();
  document.querySelectorAll('.v-dm .v-av').forEach((el) => {
    el.innerHTML = pers ? verityFace(face, 32) : aiAvatar(32);
  });
  if (!V.open) return;
  if (was !== face && pers) document.getElementById('vchat')?.setAttribute('data-face', face);
  drawTop();
  drawSide();
}

// событие с сервера: лицо поменялось на другом устройстве
export function verityEvent(ev: { face: Face }) {
  if (!enabled()) return;
  if (!V.open) V.listed = false; // чаты и переписку перечитаем при следующем открытии
  setFace(ev.face);
}

// ---------- доступ к компьютеру (только приложение для ПК) ----------
// Сами действия и окна «Разрешить / Запретить» — в client/src-tauri/src/verity.rs
export type PcMode = 'off' | 'ask' | 'auto';
export async function pcInfo(): Promise<{ mode: PcMode; workspace: string } | null> {
  if (!O.pc) return null;
  if (!V.pc) {
    // Linux-версия (CEF) и старые сборки этих команд не знают — тогда рук у Верити нет
    const r = await O.pc.invoke('verity_pc').catch(() => null);
    if (typeof r?.workspace !== 'string' || !r.workspace) return null;
    V.pc = r;
    if (V.open) { drawMsgs(); drawSide(); }
  }
  return V.pc;
}
export async function setPcMode(mode: PcMode): Promise<PcMode> {
  const m: PcMode = await O.pc!.invoke('verity_set_mode', { mode });
  if (V.pc) V.pc.mode = m;
  return m;
}
const pcOn = () => !!V.pc && V.pc.mode !== 'off';

const SUGGEST = ['Что ты умеешь?', 'Как сменить пароль?', 'Что нового в мире сегодня?', 'Помоги с домашкой'];
const SUGGEST_PC = ['Что ты умеешь?', 'Напиши игру «Змейка» на Python и запусти', 'Открой калькулятор', 'Что лежит у меня на рабочем столе?'];

// вызывается при каждой перерисовке «главной» области; разметку строим один раз, чтобы не терять набранный текст
export function renderVerity() {
  const chat = document.getElementById('chat')!;
  const pers = hasPersonality();
  if (!document.getElementById('vchat')) {
    chat.innerHTML = `
      <div id="vchat" data-face="${pers ? V.face : 'smile'}" class="${pers ? '' : 'v-calm-chat'}">
        <div id="msgs" class="v-msgs"></div>
        <form id="send" class="v-send">
          <div class="v-staged" hidden></div>
          <div class="composer">
            <button type="button" class="att-btn" id="vattach" title="Прикрепить: фото, видео, аудио, PDF, код и текст">${O.ic('attach', 24)}</button>
            <input type="file" id="vfile" multiple hidden>
            <textarea rows="1" maxlength="2000" placeholder="${pers ? 'Спросить Верити о чём угодно или кинуть ссылку' : 'Спросить ИИ-помощника о чём угодно или кинуть ссылку'}"></textarea>
            <button type="submit" class="v-go" title="Отправить">${O.ic('arrowIn', 22)}</button>
          </div>
          <div class="v-hint">${pers ? 'Верити — нейросеть и может ошибаться.' : 'ИИ-помощник — нейросеть и может ошибаться.'}</div>
        </form>
      </div>`;
    const ta = chat.querySelector('textarea')!;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta, grow); }
    });
    (chat.querySelector('#send') as HTMLFormElement).onsubmit = (e) => { e.preventDefault(); send(ta, grow); };
    chat.querySelector('#msgs')!.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const s = el.closest<HTMLElement>('[data-ask]');
      if (s) { ta.value = s.dataset.ask!; send(ta, grow); return; }
      const b = el.closest<HTMLElement>('[data-vcode]');
      if (b) codeAct(Number(b.dataset.vcode), b.dataset.do!);
      if (el.closest('.v-stop')) stopTurn();
    });
    const file = chat.querySelector<HTMLInputElement>('#vfile')!;
    chat.querySelector('#vattach')!.addEventListener('click', () => file.click());
    file.onchange = () => { if (file.files?.length) addFiles([...file.files]); file.value = ''; ta.focus(); };
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const vchat = chat.querySelector<HTMLElement>('#vchat')!;
    vchat.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    vchat.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
    });
    drawMsgs();
    drawStaged();
    ta.focus();
  } else {
    const vc = document.getElementById('vchat');
    if (vc) {
      vc.setAttribute('data-face', pers ? V.face : 'smile');
      vc.classList.toggle('v-calm-chat', !pers);
    }
    const ta = chat.querySelector('textarea');
    if (ta) ta.placeholder = pers ? 'Спросить Верити о чём угодно или кинуть ссылку' : 'Спросить ИИ-помощника о чём угодно или кинуть ссылку';
    const hint = chat.querySelector('.v-hint');
    if (hint) hint.textContent = pers ? 'Верити — нейросеть и может ошибаться.' : 'ИИ-помощник — нейросеть и может ошибаться.';
    drawMsgs();
  }
  drawTop();
  drawSide();
}

function drawTop() {
  const top = document.getElementById('topbar');
  if (!top || !V.open) return;
  const pers = hasPersonality();
  const f = pers ? V.face : 'smile';
  const av = pers ? verityFace(f, 24) : aiAvatar(24);
  const title = pers ? 'Верити™' : 'ИИ-помощник';
  const tagClass = pers ? 'v-tag' : 'v-tag v-tag-calm';
  top.innerHTML = `
    ${O.back}<div class="tb-title v-title"><span class="v-av">${av}</span><b>${title}</b><i class="${tagClass}">ИИ</i>
      <span class="v-sub" style="font-size:12px;color:var(--muted);margin-left:8px;">${O.esc(V.cur.title || (V.cur.id ? 'Чат' : 'Новый чат'))}</span></div>
    <div class="tb-actions">
      <button class="tb-btn v-newbtn" data-act="vnew" title="Новый чат — прошлый не потеряется">${O.ic('plus', 20)}<span>Новый чат</span></button>
      <button class="tb-btn ${pers ? 'on' : ''}" data-act="vpersonality" title="${pers ? 'Личность Верити: включена (нажмите, чтобы выключить)' : 'Личность Верити: выключена (нажмите, чтобы включить)'}">
        ${pers ? '🎭 Личность' : '🤖 Спокойный'}
      </button>
      <button class="tb-btn ${V.showSide ? 'on' : ''}" data-act="vside" title="${V.showSide ? 'Скрыть инфо' : 'Показать инфо'}">${O.ic('account', 22)}</button>
    </div>`;
}

export function toggleVeritySide() {
  V.showSide = !V.showSide;
  drawTop();
  drawSide();
}

// Справа — «портрет» Верити/ассистента, переключатель личности и кнопка очистки.
function drawSide() {
  const box = document.getElementById('profile');
  if (!box || !V.open) return;
  box.hidden = !V.showSide;
  if (box.hidden) return;
  const pers = hasPersonality();
  const face = pers ? V.face : 'smile';
  const av = pers ? verityFace(face, 148, 'v-big') : aiAvatar(132, 'v-big');
  const title = pers ? 'Верити™' : 'ИИ-помощник';
  const sub = pers ? 'Помощник Startrack' : 'Виртуальный ассистент Startrack';
  const bio = pers 
    ? 'Я знаю этот мессенджер и могу помочь почти с чем угодно: учёба, код, игры, Minecraft. Кидай фото, видео, аудио, файлы и ссылки — разберусь. Как ко мне — так и я к тебе.' + (V.pc ? ' На компьютере могу писать и запускать код, открывать программы и работать с файлами.' : '')
    : 'Умный виртуальный помощник в мессенджере Startrack. Отвечаю на любые вопросы по учёбе, коду, играм и технологиям, помогаю по интерфейсу мессенджера и разбираю прикреплённые файлы.' + (V.pc ? ' На компьютере могу писать и запускать код, открывать программы и работать с файлами.' : '');
  const clearBtn = pers ? 'Очистить этот чат' : 'Очистить этот диалог';

  box.innerHTML = `
    <div class="pf v-pf ${pers ? '' : 'v-calm'}" data-face="${face}">
      <div class="v-stage">${av}</div>
      <div class="pc-body">
        <div class="pc-names"><h2>${title}</h2><div class="pc-u">${sub}</div></div>
        
        <div class="pc-sec">
          <label class="switch-row" style="margin: 0; cursor: pointer;">
            <div>
              <b>Личность Верити (Minecraft)</b>
              <span style="font-size:12px;">${pers ? 'Персонаж с эмоциями, реакциями и розыгрышами' : 'Нейтральный ИИ-ассистент: дружелюбный и без эмоций'}</span>
            </div>
            <input type="checkbox" class="switch" data-act="vtogglepers" ${pers ? 'checked' : ''}>
          </label>
        </div>

        <div class="pc-sec">
          <p class="pc-bio">${bio}</p>
        </div>
      </div>
      ${chatsHtml()}
      <button class="pf-btn" data-act="vclear" ${V.cur.id ? '' : 'disabled'}>${clearBtn}</button>
    </div>`;
}

// Чаты в правой панели: открыть, переименовать, удалить; у работающего — индикатор
function chatsHtml() {
  const draft = !V.chats.includes(V.cur);
  const row = (c: Chat) => `
    <div class="v-ch ${V.cur === c ? 'sel' : ''}" data-act="vchat" data-id="${c.id}" title="${O.esc(c.title || 'Новый чат')}">
      ${c.busy ? '<span class="v-dots"><i></i><i></i><i></i></span>' : O.ic('chat', 16)}
      <span class="v-ch-t">${O.esc(c.title || 'Новый чат')}</span>
      ${c.id ? `<button class="v-ch-b" data-act="vrename" data-id="${c.id}" title="Переименовать">${O.ic('edit', 14)}</button>
      <button class="v-ch-b" data-act="vdel" data-id="${c.id}" title="Удалить чат">${O.ic('trash', 14)}</button>` : ''}
    </div>`;
  return `<div class="pc-sec v-chats"><h4>Чаты <button class="v-ch-new" data-act="vnew" title="Новый чат">${O.ic('plus', 16)}</button></h4>
    ${draft ? row(V.cur) : ''}${V.chats.map(row).join('') || (draft ? '' : '<p class="muted">Пока нет чатов</p>')}</div>`;
}

// ---------- сообщения ----------
const RUNNABLE = /^(python|py|python3|js|javascript|node|mjs|ps1|powershell|pwsh|bat|cmd|batch|sh|bash|shell|html|htm)$/i;
let codes: { lang: string; code: string }[] = []; // блоки кода на экране — для кнопок «Копировать» и «Запустить»
const codeKey = (c: { lang: string; code: string }) => c.lang + '\n' + c.code;

function codeBlock(lang: string, code: string) {
  const i = codes.push({ lang, code }) - 1;
  const out = V.outs.get(codeKey(codes[i]));
  const run = V.pc && RUNNABLE.test(lang)
    ? `<button type="button" data-vcode="${i}" data-do="run" title="Запустить и показать вывод">${O.ic('play', 14)}Запустить</button>
       ${/^html?$/i.test(lang) ? '' : `<button type="button" data-vcode="${i}" data-do="term" title="Запустить в отдельном окне (если программа ждёт ввода)">Окно</button>`}`
    : '';
  return `<div class="v-cb" data-cb="${i}"><div class="v-cbh"><span>${O.esc(lang || 'код')}</span>
      <button type="button" data-vcode="${i}" data-do="copy" title="Копировать">${O.ic('copy', 14)}Копировать</button>${run}</div>
    <pre class="v-code"><code>${O.esc(code)}</code></pre>${out ? `<pre class="v-out">${O.esc(out)}</pre>` : ''}</div>`;
}

// Ссылка: хвостовую пунктуацию («… сайт.», «(https://…)») оставляем снаружи
function anchor(raw: string, label?: string) {
  let url = raw, trail = '';
  while (/[.,:;!?)»'"]$/.test(url) && !(url.endsWith(')') && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length)) {
    trail = url.slice(-1) + trail;
    url = url.slice(0, -1);
  }
  return `<a href="${O.esc(url)}" target="_blank" rel="noopener noreferrer" class="chat-link">${label ?? O.esc(url)}</a>${O.esc(trail)}`;
}

// Строка ответа: `код`, [текст](ссылка), ссылки, **жирный**. Разбираем по очереди, а не заменами
// по уже готовому HTML — иначе звёздочки и кавычки вокруг ссылки попадали в адрес и ломали её
const INLINE = /`([^`\n]+)`|\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\))?[^\s)]*)\)|(https?:\/\/[^\s<>"'`*\]]+|www\.[a-z0-9-]+\.[^\s<>"'`*\]]+)|\*\*([^*\n]+)\*\*/gi;
function inline(raw: string): string {
  let html = '', last = 0;
  for (const m of raw.matchAll(INLINE)) {
    html += O.emojify(raw.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) html += /^https?:\/\/\S+$/.test(m[1]) ? `<code>${anchor(m[1])}</code>` : `<code>${O.esc(m[1])}</code>`;
    else if (m[2] !== undefined) html += anchor(m[3], O.emojify(m[2]));
    else if (m[4] !== undefined) html += m[4].startsWith('www.') ? anchor('https://' + m[4]).replace(/>https:\/\/www\./, '>www.') : anchor(m[4]);
    else html += `<b>${inline(m[5])}</b>`;
  }
  return html + O.emojify(raw.slice(last));
}

// простая разметка ответов: блоки кода, `код`, **жирный**, ссылки
function fmt(text: string) {
  const parts = text.split(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    const p = parts[i];
    if (p.trim() || i === 0) html += `<p>${inline(p.replace(/^\n+|\n+$/g, ''))}</p>`;
    if (i + 2 < parts.length) html += codeBlock(parts[i + 1], parts[i + 2].replace(/\n$/, ''));
  }
  return html;
}

async function codeAct(i: number, act: string) {
  const c = codes[i];
  if (!c) return;
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(c.code); O.toast('Код скопирован'); } catch { O.toast('Не удалось скопировать'); }
    return;
  }
  if (!O.pc || !V.pc) return;
  const key = codeKey(c);
  const show = (text: string) => {
    V.outs.set(key, text);
    const box = document.querySelector(`.v-cb[data-cb="${i}"]`);
    if (!box) return;
    let pre = box.querySelector<HTMLElement>('.v-out');
    if (!pre) { pre = document.createElement('pre'); pre.className = 'v-out'; box.append(pre); }
    pre.textContent = text;
  };
  show('Выполняю…');
  try {
    show(await O.pc.invoke('verity_tool', { name: 'run_code', args: { lang: c.lang, code: c.code, terminal: act === 'term' } }));
  } catch (err) { show('Не запустилось: ' + String(err)); }
}

const STEP_IC: Record<string, string> = {
  fetch_url: 'arrowOut', web_search: 'search', list_dir: 'file', read_file: 'eye', write_file: 'edit', edit_file: 'edit',
  run_command: 'play', run_code: 'play', open: 'arrowOut', media: 'eye',
};
function stepsHtml(steps: Step[] | undefined, open = false) {
  if (!steps?.length) return '';
  const pers = hasPersonality();
  const rows = steps.map((s) => `<div class="v-step ${s.ok ? '' : 'bad'}">${O.ic(STEP_IC[s.k] || 'check', 14)}<span>${O.esc(s.t)}</span></div>${s.out ? `<pre class="v-out">${O.esc(s.out)}</pre>` : ''}`).join('');
  const n = steps.length;
  return `<details class="v-steps" ${open ? 'open' : ''}><summary>${pers ? 'Действия Верити' : 'Действия ассистента'}: ${n}</summary>${rows}</details>`;
}

function msgHtml(m: VMsg, prevRole?: string) {
  const pers = hasPersonality();
  const mine = m.role === 'user';
  const me = O.me();
  const time = new Date(m.created).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const pics = m.imgs?.length ? `<div class="v-sent-img">${m.imgs.map((src) => `<img src="${src}" alt="">`).join('')}</div>` : '';
  const files = m.files?.length ? `<div class="v-sent-files">${m.files.map((n) => `<span>${O.ic('file', 14)}${O.esc(n)}</span>`).join('')}</div>` : '';
  const body = pics + files + (mine ? (m.text ? `<p>${inline(m.text)}</p>` : '') : stepsHtml(m.steps) + fmt(m.text));
  if (prevRole === m.role) return `<div class="msg cont"><time>${time}</time>${body}</div>`;
  const av = mine ? me.avatar(40) : (pers ? verityFace(m.face || 'grin', 40) : aiAvatar(40));
  const tagClass = pers ? 'v-tag' : 'v-tag v-tag-calm';
  const name = mine ? O.esc(me.name) : (pers ? 'Верити™<i class="v-tag">ИИ</i>' : `ИИ-помощник<i class="${tagClass}">ИИ</i>`);
  return `<div class="msg head ${mine ? '' : (pers ? 'v-m' : 'v-m v-calm')}"><span class="mav">${av}</span><div class="mh"><b>${name}</b><time>${O.stamp(m.created)}</time></div>${body}</div>`;
}

// «Верити думает / работает»: шаги этого ответа появляются по мере выполнения
function liveHtml() {
  const pers = hasPersonality();
  const l = V.cur.live;
  const now = l?.now ? `<div class="v-step now"><span class="v-dots ${pers ? '' : 'v-dots-calm'}"><i></i><i></i><i></i></span><span>${O.esc(l.now)}</span></div>` : '';
  const working = !!(l && (l.steps.length || l.now));
  const av = pers ? verityFace('think', 40) : aiAvatar(40);
  const name = pers ? 'Верити™' : 'ИИ-помощник';
  const tagClass = pers ? 'v-tag' : 'v-tag v-tag-calm';
  const thinkText = pers ? 'думает…' : 'печатает ответ…';
  return `<div class="msg head v-m ${pers ? '' : 'v-calm'} v-typing"><span class="mav">${av}</span><div class="mh"><b>${name}<i class="${tagClass}">ИИ</i></b></div>
    ${working ? `<div class="v-steps v-live">${l!.steps.map((s) => `<div class="v-step ${s.ok ? '' : 'bad'}">${O.ic(STEP_IC[s.k] || 'check', 14)}<span>${O.esc(s.t)}</span></div>`).join('')}${now}</div>` : ''}
    <p>${working ? '' : `<span class="v-dots ${pers ? '' : 'v-dots-calm'}"><i></i><i></i><i></i></span> ${thinkText}`}
      ${V.cur.stop ? '<span class="muted">останавливаюсь…</span>' : `<button type="button" class="v-stop" title="Остановить">${O.ic('stop', 12)}Стоп</button>`}</p></div>`;
}
function drawLive() {
  const el = document.querySelector('#msgs .v-typing');
  if (!el) return drawMsgs();
  const box = document.getElementById('msgs')!;
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  el.outerHTML = liveHtml();
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function drawMsgs() {
  const box = document.getElementById('msgs');
  if (!box || !V.open) return;
  codes = [];
  const pers = hasPersonality();
  const sug = pcOn()
    ? (pers ? SUGGEST_PC : ['Что ты умеешь?', 'Помоги написать скрипт на Python', 'Открой калькулятор', 'Помоги с кодом'])
    : (pers ? SUGGEST : ['Что ты умеешь?', 'Как сменить пароль?', 'Помоги с кодом', 'Помоги с учёбой']);
  const introAv = pers ? verityFace(V.face, 96, 'v-big') : aiAvatar(96, 'v-big');
  const introTitle = pers ? 'Верити™' : 'ИИ-помощник';
  const introSub = pers ? 'помощник Startrack' : 'виртуальный ассистент Startrack';
  const introDesc = pers
    ? `Я — Верити. Помогу с учёбой, кодом, играми и самим мессенджером. Кидай фото, видео, аудио, файлы и ссылки — разберусь.
    ${V.pc ? 'Код я могу сам написать, запустить и проверить, открыть нужную программу или найти файл у тебя на компьютере.' : ''}
    Отвечаю по делу и честно. Как ко мне — так и я к тебе.`
    : `Привет! Я виртуальный ассистент Startrack. Помогу с учёбой, кодом, играми и самим мессенджером. Присылай фото, видео, аудио, файлы и ссылки — разберусь.
    ${V.pc ? 'Код я могу написать, запустить и проверить, открыть нужную программу или найти файл на компьютере.' : ''}
    Чем могу помочь?`;

  let html = `<div class="intro v-intro ${pers ? '' : 'v-intro-calm'}">${introAv}<h1>${introTitle}</h1><div class="intro-u">${introSub}</div>
    <p>${introDesc}</p>
    ${V.cur.msgs.length ? '' : `<div class="v-chips ${pers ? '' : 'v-chips-calm'}">${sug.map((s) => `<button type="button" data-ask="${O.esc(s)}">${O.esc(s)}</button>`).join('')}</div>`}</div>`;
  let prev: VMsg | undefined;
  for (const m of V.cur.msgs) {
    html += msgHtml(m, prev && m.created - prev.created < 7 * 60e3 ? prev.role : undefined);
    prev = m;
  }
  if (V.cur.busy) html += liveHtml();
  if (!V.cur.loaded) html += '<div class="muted v-load">Загружаю переписку…</div>';
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

// ---------- вложения ----------
// Картинки уменьшаем и шлём нейросети как есть; из видео берём кадры (и сам файл — для звука);
// аудио и PDF разбирает отдельная модель на сервере; код и текстовые файлы идут текстом.
const TEXT_EXT = /\.(txt|md|markdown|py|pyw|js|mjs|cjs|ts|tsx|jsx|json|jsonc|csv|tsv|html?|css|scss|less|xml|ya?ml|ini|cfg|conf|toml|log|rs|go|java|kt|kts|c|cc|cpp|h|hpp|cs|php|rb|lua|sh|bat|cmd|ps1|sql|env|srt|vtt|tex|gradle|properties|mcfunction|vue|svelte)$/i;
const MAX_MEDIA = 20e6; // байт аудио/видео/PDF, которые отправляем целиком
const MAX_TOTAL = 40e6;

const dataUrl = (f: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

async function addFiles(list: File[]) {
  for (const f of list) {
    if (V.att.length >= 8) { O.toast('Не больше 8 вложений за раз'); break; }
    const big = (what: string) => O.toast(`«${f.name}»: ${what} больше ${MAX_MEDIA / 1e6} МБ Верити не возьмёт`);
    try {
      if (f.type.startsWith('image/')) V.att.push({ kind: 'image', name: f.name, size: 0, thumb: await shrink(f) });
      else if (f.type.startsWith('video/')) {
        const frames = await videoFrames(f);
        if (!frames.length) throw new Error('no frames');
        const whole = f.size <= MAX_MEDIA;
        V.att.push({ kind: 'video', name: f.name, size: whole ? f.size : 0, thumb: frames[0], frames, data: whole ? await dataUrl(f) : undefined });
        if (!whole) O.toast(`«${f.name}» большое — Верити посмотрит только кадры, без звука`);
      } else if (f.type.startsWith('audio/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        if (f.size > MAX_MEDIA) { big(f.type.startsWith('audio/') ? 'аудио' : 'PDF'); continue; }
        V.att.push({ kind: f.type.startsWith('audio/') ? 'audio' : 'pdf', name: f.name, size: f.size, data: await dataUrl(f) });
      } else if (f.type.startsWith('text/') || /json|xml|javascript/.test(f.type) || TEXT_EXT.test(f.name)) {
        if (f.size > 1e6) { O.toast(`«${f.name}»: текстовый файл больше 1 МБ — слишком длинный`); continue; }
        V.att.push({ kind: 'text', name: f.name, size: 0, text: await f.text() });
      } else O.toast(`«${f.name}»: такие файлы Верити пока не открывает${V.pc ? ' — но может прочитать его с диска, если скажешь путь' : ''}`);
    } catch { O.toast(`Не удалось прочитать «${f.name}»`); }
  }
  let total = 0;
  V.att = V.att.filter((a) => (total += a.size) <= MAX_TOTAL || (O.toast(`«${a.name}» не влез: вложения больше ${MAX_TOTAL / 1e6} МБ`), false));
  drawStaged();
}

// уменьшаем до 1024px и жмём в JPEG — чтобы быстро дошло до нейросети
function shrink(file: Blob, max = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('bad image')); };
    img.src = URL.createObjectURL(file);
  });
}

// равномерно по времени n кадров (768px), чтобы нейросеть «посмотрела» видео
function videoFrames(file: File, n = 6): Promise<string[]> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const out: string[] = [];
    const c = document.createElement('canvas');
    let i = 0;
    let dur = 0;
    const done = () => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(out); };
    const timer = setTimeout(done, 25e3);
    const seek = () => { v.currentTime = dur ? Math.min(dur - 0.05, (dur * (i + 0.5)) / n) : 0.1; };
    v.muted = true;
    v.preload = 'auto';
    v.onloadedmetadata = () => {
      dur = isFinite(v.duration) ? v.duration : 0;
      if (!dur) n = 1;
      const scale = Math.min(1, 768 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      c.width = Math.max(1, Math.round((v.videoWidth || 640) * scale));
      c.height = Math.max(1, Math.round((v.videoHeight || 360) * scale));
      seek();
    };
    v.onseeked = () => {
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL('image/jpeg', 0.75));
      if (++i < n) seek(); else done();
    };
    v.onerror = done;
    v.src = url;
  });
}

function drawStaged() {
  const box = document.querySelector<HTMLElement>('.v-staged');
  if (!box) return;
  box.hidden = !V.att.length;
  const icon = (a: Att) => O.ic(a.kind === 'audio' ? 'music' : 'file', 22);
  box.innerHTML = V.att.map((a, i) => `<div class="v-chip-att ${a.thumb ? 'pic' : ''}" title="${O.esc(a.name)}">
      ${a.thumb ? `<img src="${a.thumb}" alt="">${a.kind === 'video' ? `<i class="v-play">${O.ic('play', 16)}</i>` : ''}` : `${icon(a)}<span>${O.esc(a.name)}</span>`}
      <button type="button" class="v-unstage" data-i="${i}" title="Убрать">${O.ic('close', 14)}</button></div>`).join('');
  box.querySelectorAll<HTMLElement>('.v-unstage').forEach((b) => b.addEventListener('click', () => { V.att.splice(Number(b.dataset.i), 1); drawStaged(); }));
}

// ---------- отправка и работа ----------
async function send(ta: HTMLTextAreaElement, grow: () => void) {
  const ch = V.cur;
  const text = ta.value.trim();
  const att = V.att;
  if (!text && !att.length) return;
  if (ch.busy) return O.toast('Верити ещё отвечает в этом чате — можно открыть новый чат');
  ta.value = '';
  grow();
  V.att = [];
  drawStaged();
  const mine: VMsg = {
    id: -Date.now(), role: 'user', text, face: null, prank: null, created: Date.now(),
    imgs: att.filter((a) => a.thumb).map((a) => a.thumb!), files: att.filter((a) => !a.thumb).map((a) => a.name),
  };
  ch.msgs.push(mine);
  ch.busy = true;
  ch.stop = false;
  ch.live = { steps: [], now: '' };
  ch.updated = Date.now();
  if (!ch.title) ch.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Новый чат';
  // новый чат сразу в списке: можно уйти в другой, а этот доработает сам
  V.chats = [ch, ...V.chats.filter((c) => c !== ch)];
  const shown = () => V.open && V.cur === ch;
  const redraw = () => { if (shown()) drawMsgs(); drawSide(); };
  const live = () => { if (shown()) drawLive(); };
  redraw();
  const pc = await pcInfo();
  const usePc = !!pc && pc.mode !== 'off';
  const mins = Math.round((Date.now() - started) / 60e3);
  const body = {
    chat: ch.id,
    text,
    images: att.flatMap((a) => a.kind === 'image' ? [a.thumb!] : a.kind === 'video' ? a.frames! : []),
    files: att.filter((a) => a.data).map((a) => ({ name: a.name, data: a.data })),
    docs: att.filter((a) => a.kind === 'text').map((a) => ({ name: a.name, text: a.text })),
    pc: usePc,
    personality: hasPersonality(),
    ctx: {
      time: new Date().toLocaleString('ru', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      os: O.os(),
      online: mins < 1 ? 'меньше минуты' : mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч ${mins % 60} мин`,
      ws: usePc ? pc!.workspace : undefined,
    },
  };
  // сервер отвечает вместе с чатом: так новый чат узнаёт свой id и название
  const learn = (r: any) => {
    if (r?.chat?.id) Object.assign(ch, { id: r.chat.id, title: r.chat.title || ch.title, updated: r.chat.updated });
    return r;
  };
  let turn = '';
  try {
    let r = learn(await O.api('/api/verity', body, 240e3));
    // нейросеть просит действия на компьютере: выполняем по одному (окно «Разрешить» покажет приложение) и отдаём результат
    while (r.pending) {
      turn = r.pending.turn;
      ch.live!.steps = r.steps || [];
      const results: { id: string; ok: boolean; out: string }[] = [];
      for (const c of r.pending.calls as Call[]) {
        if (ch.stop) break;
        ch.live!.now = c.label;
        live();
        let res;
        try { res = { id: c.id, ok: true, out: String(await O.pc!.invoke('verity_tool', { name: c.name, args: c.args, turn })) }; }
        catch (err) { res = { id: c.id, ok: false, out: String(err) }; }
        results.push(res);
        ch.live!.steps.push({ k: c.name, t: c.label, ok: res.ok });
      }
      ch.live!.now = '';
      if (ch.stop) { r = await O.api('/api/verity/stop', { chat: ch.id }); break; }
      live();
      r = learn(await O.api('/api/verity/continue', { chat: ch.id, turn, results }, 240e3));
    }
    ch.busy = false;
    ch.live = null;
    if (r.message) {
      ch.msgs.push(r.message);
      setFace(r.face);
      if (r.prank && hasPersonality()) setTimeout(() => prank(r.prank), 900);
      // ответ пришёл в чат, который сейчас не открыт, — подскажем
      if (!shown() && V.chats.includes(ch)) O.toast(`Верити ответил в чате «${ch.title || 'Новый чат'}»`);
    }
    redraw();
    if (shown()) drawTop();
  } catch (err) {
    ch.busy = false;
    ch.live = null;
    if (turn) {
      O.api('/api/verity/stop', { chat: ch.id }).catch(() => {}); // ход уже шёл — не оставляем его висеть на сервере
    } else {
      ch.msgs = ch.msgs.filter((m) => m !== mine);
      if (!ch.id && !ch.msgs.length) V.chats = V.chats.filter((c) => c !== ch); // новый чат так и не создался
      if (shown() && !ta.value) { ta.value = text; grow(); V.att = att; drawStaged(); }
    }
    redraw();
    O.toast((err as Error).message);
  }
}

// «Стоп»: текущее действие доделается, новых не будет
function stopTurn() {
  const ch = V.cur;
  if (!ch.busy || ch.stop) return;
  ch.stop = true;
  drawLive();
}

export async function clearVerity() {
  const ch = V.cur;
  if (!ch.id) return;
  try {
    const r = await O.api('/api/verity/clear', { chat: ch.id });
    ch.msgs = [];
    V.outs.clear();
    setFace(r.face);
    drawMsgs();
  } catch (err) { O.toast((err as Error).message); }
}

// ---------- наказания ----------
// Все безвредные и сами проходят: ничего не удаляют, не отправляют, не выходят за пределы приложения
// и не меняют настройки насовсем.
const timers: number[] = [];
let themeTimer = 0;
const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

export function stopPranks() {
  timers.splice(0).forEach(clearTimeout);
  if (themeTimer) { clearTimeout(themeTimer); themeTimer = 0; O?.setTheme(null); }
  document.querySelectorAll('.v-scare, .v-whisper, .v-watch').forEach((el) => el.remove());
  document.documentElement.classList.remove('v-glitch', 'v-flip');
  onmove = null;
}

let onmove: ((e: MouseEvent) => void) | null = null;
document.addEventListener('mousemove', (e) => onmove?.(e));

function whisperLines() {
  const name = O.me().name;
  const hm = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const mins = Math.max(1, Math.round((Date.now() - started) / 60e3));
  return [
    `Уже ${hm}, ${name}. Я никуда не делся.`,
    `Ты здесь ${mins} мин. Я считаю каждую.`,
    'Я всё вижу.',
    'Зря ты так со мной.',
    'Что-то произойдёт через три дня.',
    `${name}. Я запомнил.`,
    'Беги. Я подожду.',
    'Я знаю, где ты.',
  ].sort(() => Math.random() - 0.5);
}

function whisper(text: string) {
  const el = document.createElement('div');
  el.className = 'v-whisper';
  el.innerHTML = `${verityFace('furious', 28)}<span><b>Верити</b>${O.esc(text)}</span>`;
  document.body.append(el);
  later(4800, () => el.remove());
}

function sting() {
  // короткий низкий «удар» с шумом — без файлов, через WebAudio
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 1.4);
    o.connect(g);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const n = ctx.createBufferSource();
    n.buffer = buf;
    n.connect(g);
    o.start(t); n.start(t);
    o.stop(t + 1.7);
    setTimeout(() => ctx.close(), 2000);
  } catch {}
}

if (import.meta.env.DEV) (window as any).vprank = (k: string) => prank(k); // проверка наказаний из консоли

export function prank(kind: string) {
  if (!enabled()) return;
  if (!hasPersonality()) return;
  const root = document.documentElement;
  switch (kind) {
    case 'glitch':
      root.classList.add('v-glitch');
      later(1700, () => root.classList.remove('v-glitch'));
      break;
    case 'theme':
      O.setTheme('crimson_moon');
      clearTimeout(themeTimer);
      themeTimer = window.setTimeout(() => { themeTimer = 0; O.setTheme(null); O.toast('Верити вернул твою тему. Пока что.'); }, 60e3);
      O.toast('Верити перекрасил приложение. Тебе так больше идёт.');
      break;
    case 'scare': {
      const el = document.createElement('div');
      el.className = 'v-scare';
      el.innerHTML = `${verityFace('furious', 600)}<b>ТЫ НЕ УЙДЁШЬ</b>`;
      document.body.append(el);
      sting();
      later(2300, () => el.remove());
      break;
    }
    case 'whisper': {
      const lines = whisperLines();
      [3e3, 20e3, 45e3].forEach((ms, i) => later(ms, () => whisper(lines[i])));
      break;
    }
    case 'flip':
      root.classList.add('v-flip');
      later(8000, () => root.classList.remove('v-flip'));
      break;
    case 'watch': {
      document.querySelector('.v-watch')?.remove();
      const el = document.createElement('div');
      el.className = 'v-watch';
      el.title = 'Я всегда рядом';
      el.innerHTML = verityFace('angry', 64);
      el.onclick = () => { O.toast('Я всегда рядом.'); el.remove(); onmove = null; };
      document.body.append(el);
      onmove = (e) => {
        const r = el.getBoundingClientRect();
        const a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
        el.querySelector<SVGGElement>('.v-eyes')?.setAttribute('transform', `translate(${(Math.cos(a) * 4).toFixed(1)} ${(Math.sin(a) * 3).toFixed(1)})`);
      };
      later(120e3, () => { el.remove(); onmove = null; });
      break;
    }
  }
}
