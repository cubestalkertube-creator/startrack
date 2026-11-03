type App = { id: string; owner: number; name: string; slug: string; description: string; published: number; html?: string; updated: number };
type Opts = {
  api(path: string, body?: unknown): Promise<any>;
  esc(s: string): string;
  ic(name: string, size?: number): string;
  toast(s: string): void;
  share(command: string): boolean;
};
let O: Opts;
let selected: App | null = null;
let request = 0;
const titles = new Map<string, App>();
export function initApps(o: Opts) { O = o; }
export function resetApps() { request++; selected = null; document.getElementById('app-room')?.remove(); }
export const appCommand = (text: string) => /^\/app\s+([\p{L}\p{N}_-]{1,80})\s*$/u.exec(text.trim())?.[1] || '';
export function appCard(text: string) {
  const slug = appCommand(text);
  return slug ? `<div class="chat-app-card"><span class="app-symbol">${O.ic('code', 24)}</span><div><b data-app-title="${O.esc(slug)}">${O.esc(titles.get(slug)?.name || slug)}</b><span>Приложение Startrack · откроется в чате</span></div><button class="btn sm" data-act="appopen" data-app="${O.esc(slug)}">${O.ic('play', 16)}Открыть</button></div>` : '';
}
export function fillAppCards(box: HTMLElement) {
  box.querySelectorAll<HTMLElement>('[data-app-title]').forEach(async (el) => {
    const slug = el.dataset.appTitle!;
    try {
      const a = titles.get(slug) || await O.api('/api/apps/info?id=' + encodeURIComponent(slug));
      titles.set(slug, a); if (el.isConnected) el.textContent = a.name;
    } catch { if (el.isConnected) el.title = 'Приложение удалено или недоступно'; }
  });
}

// Opaque-origin sandbox: no same-origin, native IPC, forms, popups or parent navigation.
// The first CSP is enforced for the lifetime of the document, even if app JS removes its tag.
export function appDocument(html: string) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:dark}body{margin:0}</style>` + html.replace(/<!doctype[^>]*>/gi, '');
}
function room() {
  document.getElementById('lkfloat')?.classList.add('folded');
  let box = document.getElementById('app-room');
  if (!box) {
    box = document.createElement('section'); box.id = 'app-room';
    document.querySelector('.main > .body')!.before(box);
    box.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-app-action]');
      if (b) { e.stopPropagation(); action(b).catch((err) => O.toast(err.message)); }
    });
  }
  box.hidden = false;
  return box;
}
function heading(title: string, subtitle: string, buttons = '') {
  return `<header class="activity-head"><span class="app-symbol">${O.ic('code', 22)}</span><div><b>${O.esc(title)}</b><small>${O.esc(subtitle)}</small></div>${buttons}<button class="ibtn" data-app-action="close" title="Закрыть">${O.ic('close', 20)}</button></header>`;
}
export async function openApps() {
  const seq = ++request;
  selected = null;
  const box = room();
  box.innerHTML = heading('Мои приложения', 'Создавай с помощником. Делись в любой беседе.') + '<div class="apps-content muted">Загружаю приложения…</div>';
  try {
    const { apps } = await O.api('/api/apps');
    if (seq !== request || !box.isConnected) return;
    box.innerHTML = heading('Мои приложения', 'Черновики видны тебе. Опубликованные приложения доступны по команде.', '<button class="btn sm sec" data-app-action="import">Загрузить HTML</button>')
      + `<div class="apps-content"><div class="apps-grid">${(apps as App[]).map((a) => `<article class="app-library-card"><span class="app-status ${a.published ? 'published' : ''}">${a.published ? 'Опубликовано' : 'Черновик'}</span><h3>${O.esc(a.name)}</h3><p>${O.esc(a.description || 'HTML-приложение')}</p><code>/app ${O.esc(a.slug)}</code><div><button class="btn sm ${a.published ? 'sec' : ''}" data-app-action="open" data-id="${a.id}">${a.published ? 'Открыть' : 'Предпросмотр'}</button>${a.published ? `<button class="btn sm" data-app-action="share" data-slug="${O.esc(a.slug)}">В чат</button>` : ''}<button class="ibtn" data-app-action="delete" data-id="${a.id}" title="Удалить">${O.ic('trash', 16)}</button></div></article>`).join('') || '<div class="apps-empty"><h3>Твои идеи станут приложениями</h3><p>Попроси помощника: «Создай HTML-игру змейка». Здесь появится черновик с предпросмотром и кнопкой публикации.</p><p>Или загрузи свой самодостаточный HTML-файл до 1 МБ.</p></div>'}</div></div>`;
  } catch (err) {
    if (seq === request) box.innerHTML = heading('Мои приложения', 'Startrack') + `<div class="apps-content"><p>Не удалось загрузить приложения: ${O.esc((err as Error).message)}</p><button class="btn sm sec" data-app-action="library">Повторить</button></div>`;
  }
}
export async function openApp(id: string) {
  const seq = ++request, box = room();
  box.innerHTML = heading('Приложение', 'Загружаю…') + '<div class="apps-content muted">Открываю приложение…</div>';
  try {
    const a: App = await O.api('/api/apps/get?id=' + encodeURIComponent(id));
    if (seq !== request || !box.isConnected) return;
    selected = a;
    box.innerHTML = heading(a.name, a.published ? `/app ${a.slug}` : 'Предпросмотр · видно только тебе',
      `<button class="btn sm sec" data-app-action="library">Мои приложения</button><button class="ibtn" data-app-action="reload" title="Перезапустить">${O.ic('play', 18)}</button>${a.published ? '<button class="btn sm" data-app-action="share-current">В чат</button>' : '<button class="btn sm" data-app-action="publish">Опубликовать</button>'}`)
      + (a.published ? '' : `<form class="app-publish-form"><label>Название <input name="name" maxlength="60" value="${O.esc(a.name)}" required></label><span>После публикации появится команда для отправки друзьям.</span></form>`)
      + '<div class="app-preview"></div>';
    box.querySelector('form')?.addEventListener('submit', (e) => { e.preventDefault(); box.querySelector<HTMLButtonElement>('[data-app-action="publish"]')?.click(); });
    const frame = document.createElement('iframe');
    frame.title = a.name; frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    frame.referrerPolicy = 'no-referrer'; frame.srcdoc = appDocument(a.html || '');
    box.querySelector('.app-preview')!.append(frame);
  } catch (err) {
    if (seq === request) box.innerHTML = heading('Приложение недоступно', 'Startrack') + `<div class="apps-content"><p>${O.esc((err as Error).message)}</p><button class="btn sm sec" data-app-action="library">Мои приложения</button></div>`;
  }
}
export async function saveHtmlApp(html: string, name = 'Новое приложение') {
  const a = await O.api('/api/apps/save', { name, html });
  O.toast('Черновик сохранён в «Мои приложения»');
  await openApp(a.id);
}
async function action(b: HTMLElement) {
  switch (b.dataset.appAction) {
    case 'close': resetApps(); return;
    case 'library': return openApps();
    case 'open': return openApp(b.dataset.id!);
    case 'reload': if (selected) return openApp(selected.id); return;
    case 'share': return share(b.dataset.slug!);
    case 'share-current': if (selected) share(selected.slug); return;
    case 'publish': {
      if (!selected || b.hasAttribute('disabled')) return;
      const a = selected;
      const name = room().querySelector<HTMLInputElement>('[name="name"]')?.value.trim();
      if (!name) return O.toast('Укажи название приложения');
      b.setAttribute('disabled', '');
      try { await O.api('/api/apps/publish', { id: a.id, name }); O.toast('Опубликовано. Теперь приложение можно отправить в чат'); await openApp(a.id); }
      finally { b.removeAttribute('disabled'); }
      return;
    }
    case 'delete': {
      b.dataset.appAction = 'confirm-delete'; b.textContent = 'Удалить?'; b.title = 'Подтвердить удаление приложения'; return;
    }
    case 'confirm-delete': await O.api('/api/apps/delete', { id: b.dataset.id }); return openApps();
    case 'import': {
      const file = document.createElement('input'); file.type = 'file'; file.accept = '.html,.htm,text/html';
      file.onchange = async () => {
        const f = file.files?.[0]; if (!f) return;
        if (f.size > 1_000_000) return O.toast('Размер HTML не должен превышать 1 МБ');
        try { await saveHtmlApp(await f.text(), f.name.replace(/\.html?$/i, '')); } catch (err) { O.toast((err as Error).message); }
      };
      file.click(); return;
    }
  }
}
function share(slug: string) {
  if (O.share('/app ' + slug)) O.toast('Команда добавлена в сообщение. Нажми Enter, чтобы отправить');
  else O.toast('Открой беседу с другом и напиши /app ' + slug);
}
