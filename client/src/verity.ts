// Верити™ — ИИ-помощник (жёлтый смайлик из сериала по Minecraft). Отвечает нейросеть на сервере,
// здесь — его лица, отдельная беседа в списке «Личные сообщения» и пакости, когда его разозлили.
// Лицо зависит от злости, которую считает сервер: grin (восторг) → smile → neutral → annoyed → angry → furious.

export type Face = 'grin' | 'smile' | 'neutral' | 'annoyed' | 'angry' | 'furious' | 'think';
type VMsg = { id: number; role: 'user' | 'verity'; text: string; face: Face | null; prank: string | null; created: number };
type Mood = { anger: number; face: Face; sulk: number };

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
  isEnabled?: () => boolean;
};

let O: Opts;
const V = {
  open: false,
  loaded: false,
  loading: false,
  busy: false,
  msgs: [] as VMsg[],
  mood: { anger: 0, face: 'smile', sulk: 0 } as Mood,
  showSide: true,
};
const started = Date.now();

export function initVerity(o: Opts) { O = o; }
export const verityOpen = () => V.open;
export function closeVerity() { V.open = false; }
export function resetVerity() {
  Object.assign(V, { open: false, loaded: false, busy: false, msgs: [], mood: { anger: 0, face: 'smile', sulk: 0 } });
  stopPranks();
}

// ---------- лица ----------
const INK = '#1a1a1a';
let gradSeq = 0;
// глаза в отдельной группе — пакость «watch» поворачивает их за курсором
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

export const MOOD: Record<Face, [string, string]> = {
  grin: ['В восторге', 'Ты его лучший друг. Навсегда.'],
  smile: ['Дружелюбный', 'Готов помочь с чем угодно.'],
  neutral: ['Насторожен', 'Что-то ему не понравилось.'],
  annoyed: ['Раздражён', 'Отвечает неохотно. Лучше не груби.'],
  angry: ['Злится', 'Скоро случится что-то плохое…'],
  furious: ['В ЯРОСТИ', 'Ты не уйдёшь. Попробуй извиниться.'],
  think: ['Думает', ''],
};

// ---------- список бесед ----------
export function verityRow(filter: string) {
  if (O?.isEnabled && !O.isEnabled()) return '';
  if (filter && !'верити verity помощник ии'.includes(filter)) return '';
  const f = V.mood.face;
  return `
    <div class="dm v-dm ${V.open ? 'sel' : ''} ${f === 'furious' ? 'v-hot' : ''}" data-act="verity">
      <span class="v-av">${verityFace(f, 32)}</span>
      <div class="dm-n"><span>Верити™<i class="v-tag">ИИ</i></span><small>${f === 'smile' ? 'Твой друг-помощник' : MOOD[f][0]}</small></div>
    </div>`;
}

// ---------- беседа ----------
export async function openVerity() {
  if (O?.isEnabled && !O.isEnabled()) return;
  V.open = true;
  if (matchMedia('(max-width: 760px)').matches) V.showSide = false; // на телефоне панель закрыла бы весь чат
  if (!V.loaded && !V.loading) {
    V.loading = true;
    try {
      const r = await O.api('/api/verity');
      V.msgs = r.messages;
      setMood(r);
      V.loaded = true;
    } catch (err) { O.toast((err as Error).message); }
    V.loading = false;
    if (V.open) drawMsgs();
  }
}

function setMood(m: { anger: number; face: Face; sulk?: number }) {
  const was = V.mood.face;
  V.mood = { anger: m.anger, face: m.face, sulk: m.sulk || 0 };
  document.querySelectorAll('.v-dm').forEach((el) => {
    el.classList.toggle('v-hot', m.face === 'furious');
    el.querySelector('.v-av')!.innerHTML = verityFace(m.face, 32);
    el.querySelector('small')!.textContent = m.face === 'smile' ? 'Твой друг-помощник' : MOOD[m.face][0];
  });
  if (!V.open) return;
  if (was !== m.face) document.getElementById('vchat')?.setAttribute('data-face', m.face);
  drawTop();
  drawSide();
  drawSulk();
}

// событие с сервера: настроение поменялось на другом устройстве
export function verityEvent(ev: Mood) {
  if (O?.isEnabled && !O.isEnabled()) return;
  if (!V.open) V.loaded = false; // переписку перечитаем при следующем открытии
  setMood(ev);
}

const SUGGEST = ['Что ты умеешь?', 'Расскажи страшилку', 'Как построить портал в Энд?', 'Помоги с домашкой'];

// вызывается при каждой перерисовке «главной» области; разметку строим один раз, чтобы не терять набранный текст
export function renderVerity() {
  const chat = document.getElementById('chat')!;
  if (!document.getElementById('vchat')) {
    chat.innerHTML = `
      <div id="vchat" data-face="${V.mood.face}">
        <div id="msgs" class="v-msgs"></div>
        <form id="send" class="v-send">
          <div class="v-sulk" hidden></div>
          <div class="composer">
            <textarea rows="1" maxlength="2000" placeholder="Спросить Верити о чём угодно"></textarea>
            <button type="submit" class="v-go" title="Отправить">${O.ic('arrowIn', 22)}</button>
          </div>
          <div class="v-hint">Верити — нейросеть и может ошибаться. Не груби ему.</div>
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
      const s = (e.target as HTMLElement).closest<HTMLElement>('[data-ask]');
      if (s) { ta.value = s.dataset.ask!; send(ta, grow); }
    });
    drawMsgs();
    drawSulk();
    ta.focus();
  }
  drawTop();
  drawSide();
}

function drawTop() {
  const top = document.getElementById('topbar');
  if (!top || !V.open) return;
  top.innerHTML = `
    ${O.back}<div class="tb-title v-title"><span class="v-av">${verityFace(V.mood.face, 24)}</span><b>Верити™</b><i class="v-tag">ИИ</i>
      <span class="v-mood m-${V.mood.face}">${MOOD[V.mood.face][0]}</span></div>
    <div class="tb-actions">
      <button class="tb-btn ${V.showSide ? 'on' : ''}" data-act="vside" title="${V.showSide ? 'Скрыть' : 'Показать'} настроение Верити">${O.ic('account', 22)}</button>
    </div>`;
}

export function toggleVeritySide() {
  V.showSide = !V.showSide;
  drawTop();
  drawSide();
}

function drawSide() {
  const box = document.getElementById('profile');
  if (!box || !V.open) return;
  box.hidden = !V.showSide;
  if (box.hidden) return;
  const { anger, face } = V.mood;
  const [label, sub] = MOOD[face];
  // шкала: 0% — восторг (−30), 100% — ярость
  const pct = Math.round(((anger + 30) / 130) * 100);
  const cool = anger > 0 ? Math.ceil(anger / 2) : 0; // сервер: −1 каждые 30 секунд
  box.innerHTML = `
    <div class="pf v-pf" data-face="${face}">
      <div class="v-stage">${verityFace(face, 132, 'v-big')}</div>
      <div class="pc-body">
        <div class="pc-names"><h2>Верити™</h2><div class="pc-u">Друг-помощник • DeepSeek</div></div>
        <div class="pc-sec"><h4>Настроение</h4>
          <div class="v-meter"><i style="left:${pct}%"></i></div>
          <p class="v-ml m-${face}"><b>${label}</b> — ${sub}</p>
          ${cool ? `<p class="v-cool">Остынет примерно через ${cool} мин, если не злить.</p>` : ''}
        </div>
        <div class="pc-sec"><h4>Обо мне</h4><p class="pc-bio">Привеет! Я Верити, твой друг-помощник! Я знаю всё — спрашивай. Только не обижай меня… я этого не люблю.</p></div>
        <div class="pc-sec"><h4>Лица Верити</h4><div class="v-faces">${(['grin', 'smile', 'neutral', 'annoyed', 'angry', 'furious'] as Face[])
          .map((f) => `<span class="${f === face ? 'cur' : ''}" title="${MOOD[f][0]}">${verityFace(f, 34)}</span>`).join('')}</div></div>
      </div>
      <button class="pf-btn" data-act="vclear">Очистить переписку</button>
    </div>`;
}

// простая разметка ответов: блоки кода, `код`, **жирный**, ссылки
function fmt(text: string) {
  const parts = text.split(/```[\w+-]*\n?([\s\S]*?)```/g);
  return parts.map((p, i) => i % 2
    ? `<pre class="v-code"><code>${O.esc(p.replace(/\n$/, ''))}</code></pre>`
    : p.trim() || i === 0 ? `<p>${O.linkify(O.emojify(p.replace(/^\n+|\n+$/g, ''))
      .replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'))}</p>` : '').join('');
}

function msgHtml(m: VMsg, prevRole?: string) {
  const mine = m.role === 'user';
  const me = O.me();
  const time = new Date(m.created).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const body = mine ? `<p>${O.linkify(O.emojify(m.text))}</p>` : fmt(m.text);
  if (prevRole === m.role) return `<div class="msg cont"><time>${time}</time>${body}</div>`;
  const av = mine ? me.avatar(40) : verityFace(m.face || 'smile', 40);
  const name = mine ? O.esc(me.name) : 'Верити™<i class="v-tag">ИИ</i>';
  return `<div class="msg head ${mine ? '' : 'v-m'}"><span class="mav">${av}</span><div class="mh"><b>${name}</b><time>${O.stamp(m.created)}</time></div>${body}</div>`;
}

function drawMsgs() {
  const box = document.getElementById('msgs');
  if (!box || !V.open) return;
  let html = `<div class="intro v-intro">${verityFace(V.mood.face, 96, 'v-big')}<h1>Верити™</h1><div class="intro-u">твой друг-помощник</div>
    <p>Привеет! Я Верити, твой друг-помощник! Я знаю всё на свете: учёба, код, Minecraft, игры — спрашивай что угодно.
    Только не злите меня… у меня много лиц.</p>
    ${V.msgs.length ? '' : `<div class="v-chips">${SUGGEST.map((s) => `<button type="button" data-ask="${O.esc(s)}">${O.esc(s)}</button>`).join('')}</div>`}</div>`;
  let prev: VMsg | undefined;
  for (const m of V.msgs) {
    html += msgHtml(m, prev && m.created - prev.created < 7 * 60e3 ? prev.role : undefined);
    prev = m;
  }
  if (V.busy) html += `<div class="msg head v-m v-typing"><span class="mav">${verityFace('think', 40)}</span><div class="mh"><b>Верити™</b></div><p><span class="v-dots"><i></i><i></i><i></i></span> думает…</p></div>`;
  if (!V.loaded && V.loading) html += '<div class="muted v-load">Загружаю переписку…</div>';
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

let sulkTimer = 0;
function drawSulk() {
  clearInterval(sulkTimer);
  const el = document.querySelector<HTMLElement>('.v-sulk');
  const ta = document.querySelector<HTMLTextAreaElement>('#vchat textarea');
  if (!el || !ta) return;
  const tick = () => {
    const left = Math.ceil((V.mood.sulk - Date.now()) / 1000);
    el.hidden = left <= 0;
    ta.disabled = left > 0;
    ta.placeholder = left > 0 ? 'Верити не хочет с тобой разговаривать' : V.mood.face === 'furious' ? 'Попробуй извиниться…' : 'Спросить Верити о чём угодно';
    if (left > 0) el.innerHTML = `${verityFace('furious', 20)} Верити обиделся и молчит… ${left} с`;
    else clearInterval(sulkTimer);
  };
  tick();
  if (V.mood.sulk > Date.now()) sulkTimer = window.setInterval(tick, 1000);
}

async function send(ta: HTMLTextAreaElement, grow: () => void) {
  const text = ta.value.trim();
  if (!text || V.busy) return;
  ta.value = '';
  grow();
  const mine: VMsg = { id: -Date.now(), role: 'user', text, face: null, prank: null, created: Date.now() };
  V.msgs.push(mine);
  V.busy = true;
  drawMsgs();
  const mins = Math.round((Date.now() - started) / 60e3);
  const ctx = {
    time: new Date().toLocaleString('ru', { weekday: 'long', hour: '2-digit', minute: '2-digit' }),
    os: O.os(),
    online: mins < 1 ? 'меньше минуты' : mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч ${mins % 60} мин`,
  };
  try {
    const r = await O.api('/api/verity', { text, ctx }, 70000);
    V.msgs.push(r.message);
    V.busy = false;
    setMood(r);
    drawMsgs();
    if (r.prank) setTimeout(() => prank(r.prank), 900);
  } catch (err) {
    V.busy = false;
    V.msgs = V.msgs.filter((m) => m !== mine);
    if (V.open && !ta.value) { ta.value = text; grow(); }
    drawMsgs();
    O.toast((err as Error).message);
  }
}

export async function clearVerity() {
  try {
    setMood(await O.api('/api/verity/clear', {}));
    V.msgs = [];
    drawMsgs();
  } catch (err) { O.toast((err as Error).message); }
}

// ---------- пакости ----------
// Все безвредные и сами проходят: ничего не удаляют, не отправляют и не меняют настройки насовсем.
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
    `Уже ${hm}, ${name}. Почему ты ещё здесь?`,
    `Ты сидишь в Startrack ${mins} мин. Я считал.`,
    'Я всё ещё здесь.',
    'Не закрывай меня.',
    'Что-то произойдёт через три дня.',
    `${name}… обернись.`,
    'Друзья так не поступают.',
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

if (import.meta.env.DEV) (window as any).vprank = (k: string) => prank(k); // проверка пакостей из консоли

export function prank(kind: string) {
  if (O?.isEnabled && !O.isEnabled()) return;
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
