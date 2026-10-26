// Эмодзи как в Discord: выбор по категориям, поиск по-русски и по :коду:, часто используемые,
// оттенок кожи, подсказки при наборе «:код» и большие эмодзи в сообщениях из одних эмодзи.
// Рисуются шрифтом Twemoji (src/assets/twemoji.woff2), данные — src/emoji.json (scripts/emoji.mjs).

type Row = [string, number, string, string, string[]?];
export type Emoji = { u: string; g: number; names: string[]; words: string[]; skins?: string[] };
type Data = { groups: string[]; list: Emoji[]; byName: Map<string, Emoji>; byChar: Map<string, Emoji> };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

let data: Data | null = null;
let loading: Promise<Data> | null = null;
// данные (~300 КБ) грузим отдельным куском при первой надобности
export function loadEmoji() {
  return (loading ??= import('./emoji.json').then((m) => {
    const json = m.default as unknown as { groups: string[]; list: Row[] };
    // коды вроде «+1» показываем последними: в подвале и подсказках лучше :thumbsup:
    const list = json.list.map(([u, g, names, words, skins]) => ({
      u, g, names: names.split(' ').sort((a, b) => Number(!/^[a-z]/.test(a)) - Number(!/^[a-z]/.test(b))), words: words.split(' '), skins,
    }));
    const byName = new Map<string, Emoji>();
    const byChar = new Map<string, Emoji>();
    for (const e of list) {
      for (const n of e.names) if (!byName.has(n)) byName.set(n, e);
      for (const ch of [e.u, ...(e.skins || [])]) byChar.set(ch, e);
    }
    return (data = { groups: json.groups, list, byName, byChar });
  }));
}

// ---------- текст ----------
// \p{RGI_Emoji} (флаг v) — только «настоящие» эмодзи: цифры, ©, ™ и т.п. без FE0F не трогает
const EMO_RE = new RegExp('\\p{RGI_Emoji}', 'gv');
const MAX_JUMBO = 27; // как в Discord: до 27 эмодзи без текста — показываем крупно

// Текст сообщения в HTML: эмодзи — в <span class="emo"> (подсказка :код: при наведении)
export function emojify(text: string) {
  return esc(text).replace(EMO_RE, (m) => {
    const name = data?.byChar.get(m)?.names[0];
    return `<span class="emo"${name ? ` title=":${esc(name)}:"` : ''}>${m}</span>`;
  });
}
export function isJumbo(text: string) {
  const n = text.match(EMO_RE)?.length ?? 0;
  return n > 0 && n <= MAX_JUMBO && !text.replace(EMO_RE, '').trim();
}

// «:smile:» -> 😄 при отправке (если такой код есть)
export function replaceCodes(text: string) {
  if (!data) return text;
  return text.replace(/:([a-z0-9_+-]{1,40}):/gi, (m, n: string) => data!.byName.get(n.toLowerCase())?.u ?? m);
}

// ---------- часто используемые и оттенок кожи ----------
const DEFAULT_FREQ = ['👍', '😂', '😭', '❤️', '🔥', '😊', '🤔', '👀', '😎', '🙏', '💀', '🎉', '😡', '🥺', '✅', '😅', '🤣', '😢'];
const freq = (): Record<string, number> => { try { return JSON.parse(store.get('emojiFreq') || '{}'); } catch { return {}; } };

// Учитываем эмодзи из отправленного сообщения (оттенок кожи сводим к основному эмодзи)
export function noteUsed(text: string) {
  const all = text.match(EMO_RE);
  if (!all) return;
  const f = freq();
  for (const m of all) {
    const base = data?.byChar.get(m)?.u ?? m;
    f[base] = (f[base] || 0) + 1;
  }
  // храним не больше 100, чтобы не разрастался
  store.set('emojiFreq', JSON.stringify(Object.fromEntries(Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 100))));
}
function frequent(): Emoji[] {
  const top = Object.entries(freq()).sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const out: Emoji[] = [];
  for (const u of [...top, ...DEFAULT_FREQ]) {
    const e = data!.byChar.get(u);
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= 36) break;
  }
  return out;
}

let skin = Number(store.get('emojiSkin')) || 0; // 0 — жёлтый, 1..5 — оттенки
const withSkin = (e: Emoji) => (skin && e.skins ? e.skins[skin - 1] : e.u);

// ---------- поиск ----------
function search(query: string, limit = Infinity): Emoji[] {
  const parts = query.toLowerCase().replace(/:/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !data) return [];
  // [эмодзи, очки, длина самого короткого подходящего кода]: при равных очках короче — выше (:fir -> :fire: раньше :firefighter:)
  const scored: [Emoji, number, number][] = [];
  for (const e of data.list) {
    let score = 0;
    let len = 99;
    for (const p of parts) {
      const s = e.names.some((n) => n === p) ? 3 : e.names.some((n) => n.startsWith(p)) ? 2
        : e.words.some((w) => w.startsWith(p)) || e.names.some((n) => n.includes(p)) ? 1 : 0;
      if (!s) { score = 0; break; }
      score += s;
      for (const n of e.names) if (n.includes(p)) len = Math.min(len, n.length);
    }
    if (score) scored.push([e, score, len]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, limit).map(([e]) => e);
}

// Подсказки для «:код» в поле ввода
export const suggest = (prefix: string) => search(prefix, 10).map((e) => ({ u: withSkin(e), name: e.names[0] }));

// ---------- окно выбора ----------
const GROUP_IC = ['😀', '🐱', '🍎', '⚽', '🚗', '💡', '❤️', '🏁'];
const SKIN_IC = ['👏', '👏🏻', '👏🏼', '👏🏽', '👏🏾', '👏🏿'];
let pop: HTMLElement | null = null;
let popClose: (() => void) | null = null;

export function closePicker() {
  popClose?.();
}

// anchor — кнопка, над которой открываем; onPick(эмодзи, keep) — keep при Shift: окно не закрывается
export async function openPicker(anchor: HTMLElement, onPick: (u: string, keep: boolean) => void) {
  if (pop) return closePicker();
  const d = await loadEmoji();
  if (pop) return;
  const el = (pop = document.createElement('div'));
  el.className = 'emo-pop';
  el.innerHTML = `
    <div class="ep-top">
      <input class="ep-find" placeholder="Найдите идеальный эмодзи" spellcheck="false">
      <button class="ep-skin" title="Оттенок кожи"><span class="emo">${SKIN_IC[skin]}</span></button>
      <div class="ep-skins" hidden>${SKIN_IC.map((s, i) => `<button data-skin="${i}" class="${i === skin ? 'on' : ''}"><span class="emo">${s}</span></button>`).join('')}</div>
    </div>
    <div class="ep-mid">
      <nav class="ep-nav">
        <button data-go="f" title="Часто используемые"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.41V6h-2v7.24l4.38 2.63 1-1.71z"/></svg></button>
        ${d.groups.map((g, i) => `<button data-go="${i}" title="${esc(g)}"><span class="emo">${GROUP_IC[i]}</span></button>`).join('')}
      </nav>
      <div class="ep-list"></div>
    </div>
    <div class="ep-foot"><span class="emo ep-big"></span><b class="ep-name"></b></div>`;
  document.body.append(el);
  const find = el.querySelector<HTMLInputElement>('.ep-find')!;
  const list = el.querySelector<HTMLElement>('.ep-list')!;
  const cell = (e: Emoji) => `<button class="ep-e" data-u="${esc(e.u)}"><span class="emo">${withSkin(e)}</span></button>`;
  const section = (id: string, title: string, items: Emoji[]) =>
    `<section data-sec="${id}"><h5>${esc(title)}</h5><div class="ep-grid">${items.map(cell).join('')}</div></section>`;
  const draw = () => {
    const q = find.value.trim();
    if (q) {
      const found = search(q);
      list.innerHTML = found.length ? section('s', 'Результаты поиска', found)
        : '<div class="ep-none"><span class="emo">🔍</span>Ничего не нашлось</div>';
    } else {
      list.innerHTML = section('f', 'Часто используемые', frequent())
        + d.groups.map((g, i) => section(String(i), g, d.list.filter((e) => e.g === i))).join('');
    }
    list.scrollTop = 0;
    hover(list.querySelector<HTMLElement>('.ep-e'));
  };
  // подвал: эмодзи под курсором крупно и его :код:
  const hover = (b: HTMLElement | null) => {
    const e = b && d.byChar.get(b.dataset.u!);
    el.querySelector('.ep-big')!.textContent = e ? withSkin(e) : '';
    el.querySelector('.ep-name')!.textContent = e ? `:${e.names[0]}:` : '';
  };
  list.onmouseover = (ev) => { const b = (ev.target as HTMLElement).closest<HTMLElement>('.ep-e'); if (b) hover(b); };
  list.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('.ep-e');
    const e = b && d.byChar.get(b.dataset.u!);
    if (!e) return;
    onPick(withSkin(e), ev.shiftKey);
    if (!ev.shiftKey) closePicker();
  };
  el.querySelector<HTMLElement>('.ep-nav')!.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-go]');
    if (!b) return;
    if (find.value) { find.value = ''; draw(); }
    const sec = list.querySelector<HTMLElement>(`[data-sec="${b.dataset.go}"]`);
    if (sec) list.scrollTop = sec.offsetTop - list.offsetTop;
  };
  // подсветка категории, до которой прокрутили
  const markNav = () => {
    let cur = 'f';
    for (const s of list.querySelectorAll<HTMLElement>('section')) if (s.offsetTop - list.offsetTop <= list.scrollTop + 8) cur = s.dataset.sec!;
    el.querySelectorAll<HTMLElement>('.ep-nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === cur));
  };
  list.onscroll = markNav;
  const skins = el.querySelector<HTMLElement>('.ep-skins')!;
  el.querySelector<HTMLElement>('.ep-skin')!.onclick = () => (skins.hidden = !skins.hidden);
  skins.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-skin]');
    if (!b) return;
    skin = Number(b.dataset.skin);
    store.set('emojiSkin', String(skin));
    el.querySelector('.ep-skin .emo')!.textContent = SKIN_IC[skin];
    skins.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', i === skin));
    skins.hidden = true;
    const top = list.scrollTop;
    draw();
    list.scrollTop = top;
  };
  find.oninput = draw;
  find.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      const b = list.querySelector<HTMLElement>('.ep-e');
      const e = b && d.byChar.get(b.dataset.u!);
      if (e) { onPick(withSkin(e), ev.shiftKey); if (!ev.shiftKey) closePicker(); }
    }
  };

  // над кнопкой, правым краем к ней; не вылезая за окно
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = Math.max(8, r.top - el.offsetHeight - 8) + 'px';
  const outside = (ev: MouseEvent) => { if (!el.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) closePicker(); };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); closePicker(); } };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', key, true);
  popClose = () => {
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', key, true);
    el.remove();
    pop = null;
    popClose = null;
  };
  draw();
  markNav();
  find.focus();
}
