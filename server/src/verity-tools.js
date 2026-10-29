// Инструменты Верити. Часть выполняет сервер (ссылки, поиск в интернете),
// часть — приложение на компьютере собеседника (файлы, команды, программы; см. client/src-tauri/src/verity.rs).

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_PAGE = 3_000_000; // байт страницы
const PAGE_TEXT = 14_000; // символов текста страницы для нейросети

const fn = (name, description, properties, required = Object.keys(properties)) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const str = (description) => ({ type: 'string', description });

// Последний шаг каждого хода — answer: так ответ всегда приходит с оценкой настроения
export const ANSWER = fn('answer', 'Закончить ход и ответить собеседнику. Вызывай, когда всё сделано (или если делать ничего не нужно).', {
  reply: str('Твой ответ собеседнику (по-русски, с характером)'),
  delta: { type: 'integer', description: 'Насколько изменилась твоя злость от его сообщения: от -100 до 40, обычно 0' },
  prank: { type: 'string', enum: ['none', 'glitch', 'theme', 'scare', 'whisper', 'flip', 'watch'] },
});

export const WEB_TOOLS = [
  fn('fetch_url', 'Открыть ссылку и прочитать страницу (текст, заголовок, описание, ссылки на ней). Используй, когда собеседник прислал ссылку или нужно что-то посмотреть на сайте.', { url: str('http(s) адрес') }),
  fn('web_search', 'Поиск в интернете (DuckDuckGo). Возвращает заголовки, ссылки и фрагменты. Для свежих новостей, документации, цен и всего, чего ты не знаешь.', { query: str('Поисковый запрос') }),
];

// выполняет приложение Startrack на компьютере собеседника
export const PC_TOOLS = [
  fn('list_dir', 'Показать содержимое папки на компьютере собеседника.', { path: str('Путь; относительный — от твоей рабочей папки, ~ — домашняя папка') }),
  fn('read_file', 'Прочитать текстовый файл (с номерами строк).', {
    path: str('Путь к файлу'), offset: { type: 'integer', description: 'С какой строки (с 1)' }, limit: { type: 'integer', description: 'Сколько строк (по умолчанию 2000)' },
  }, ['path']),
  fn('write_file', 'Создать или перезаписать файл целиком (папки создаются сами). Код и проекты пиши в рабочую папку, если не просили другое место.', { path: str('Путь'), content: str('Полное содержимое файла') }),
  fn('edit_file', 'Заменить фрагмент в существующем файле. old должен совпадать до символа и встречаться один раз (или all=true).', {
    path: str('Путь'), old: str('Что заменить'), new: str('На что'), all: { type: 'boolean', description: 'Заменить все вхождения' },
  }, ['path', 'old', 'new']),
  fn('run_command', 'Выполнить команду в оболочке (Windows — PowerShell, Linux — bash) и получить вывод. Для коротких команд и скриптов; программы с окнами, игры и серверы запускай через open.', {
    command: str('Команда'), cwd: str('Папка, где выполнить (по умолчанию рабочая)'), timeout: { type: 'integer', description: 'Секунд до остановки, по умолчанию 60, максимум 600' },
  }, ['command']),
  fn('open', 'Открыть программу, файл, папку или ссылку в браузере на компьютере собеседника (не ждёт завершения). Например: notepad, calc, chrome, steam://, путь к .exe или документу.', {
    target: str('Что открыть'), args: str('Аргументы программы (необязательно)'),
  }, ['target']),
  fn('run_code', 'Сохранить код во временный файл и выполнить (python, javascript, powershell, bat, bash, html). terminal=true — в отдельном окне терминала (для программ, которые ждут ввода).', {
    lang: str('Язык'), code: str('Код'), terminal: { type: 'boolean', description: 'Открыть в отдельном окне' },
  }, ['lang', 'code']),
];
export const PC_NAMES = new Set(PC_TOOLS.map((t) => t.function.name));

// ---------- ссылки ----------
// Сервер не должен ходить по ссылкам во внутреннюю сеть (свой localhost, LiveKit, облачные метаданные).
// Проверяем адрес в момент подключения (lookup), чтобы подмена DNS между проверкой и запросом не прошла.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

function safeLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const bad = list.find((a) => privateIp(a.address));
    if (bad) return cb(new Error('адрес во внутренней сети — туда нельзя'));
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('поддерживаются только http и https'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && privateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('адрес во внутренней сети — туда нельзя'));
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      lookup: safeLookup, timeout: 15e3,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'ru,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('слишком много перенаправлений'));
        return resolve(get(new URL(res.headers.location, u).href, redirects - 1));
      }
      const enc = res.headers['content-encoding'];
      const body = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      let n = 0;
      body.on('data', (c) => { n += c.length; if (n > MAX_PAGE) { req.destroy(); body.destroy(); } else chunks.push(c); });
      const done = () => resolve({ status: res.statusCode, url: u.href, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) });
      body.on('end', done);
      body.on('close', done);
      body.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('сайт не ответил за 15 секунд')));
    req.on('error', reject);
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©' };
const unent = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ''), /^#x/i.test(e) ? 16 : 10) || 32)
  : ENT[e.toLowerCase()] ?? m);
const meta = (html, name) => unent(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, 'i').exec(html)?.[1]
  || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(html)?.[1] || '');

function htmlToText(html, base) {
  const title = unent(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  const desc = meta(html, 'og:description') || meta(html, 'description');
  const links = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = unent(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!t || t.length > 90) continue;
    try { links.push(`${t} — ${new URL(unent(m[1]), base).href}`); } catch {}
    if (links.length >= 40) break;
  }
  const text = unent(html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title, desc, text, links };
}

export async function fetchUrl(url) {
  const r = await get(String(url).trim());
  const type = r.type.toLowerCase();
  let out = `Адрес: ${r.url}\nHTTP ${r.status}, ${type || 'тип неизвестен'}\n`;
  if (/text\/html|xhtml/.test(type) || (!type && /^\s*</.test(r.body.toString('utf8', 0, 200)))) {
    const charset = /charset=([\w-]+)/.exec(type)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(r.body.toString('latin1', 0, 3000))?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(r.body); } catch { html = r.body.toString('utf8'); }
    const p = htmlToText(html, r.url);
    if (p.title) out += `Заголовок: ${p.title}\n`;
    if (p.desc) out += `Описание: ${p.desc}\n`;
    out += `\n${p.text.slice(0, PAGE_TEXT)}${p.text.length > PAGE_TEXT ? '\n… (страница обрезана)' : ''}\n`;
    if (p.links.length) out += `\nСсылки на странице:\n${p.links.join('\n')}`;
    return out;
  }
  if (/json|text\/|xml|javascript/.test(type)) {
    const t = r.body.toString('utf8');
    return out + '\n' + t.slice(0, PAGE_TEXT) + (t.length > PAGE_TEXT ? '\n… (обрезано)' : '');
  }
  return out + `Это не страница, а файл (${(r.body.length / 1024).toFixed(0)} КБ) — прочитать его как текст нельзя.`;
}

export async function webSearch(query) {
  const r = await get('https://html.duckduckgo.com/html/?kl=ru-ru&q=' + encodeURIComponent(String(query).slice(0, 300)));
  const html = r.body.toString('utf8');
  const items = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let link = unent(a[1]);
    const ud = /[?&]uddg=([^&]+)/.exec(link)?.[1];
    if (ud) link = decodeURIComponent(ud);
    if (/duckduckgo\.com\/y\.js/.test(link)) continue; // реклама
    const snip = unent((/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b)?.[1] || '').replace(/<[^>]+>/g, '')).trim();
    items.push(`${items.length + 1}. ${unent(a[2].replace(/<[^>]+>/g, '')).trim()}\n${link}\n${snip}`);
    if (items.length >= 8) break;
  }
  return items.length ? items.join('\n\n') : 'Ничего не нашлось.';
}

// Аудио, видео и документы смотрит отдельная мультимодальная модель и пересказывает их текстом
export async function describeMedia({ url, key, model }, file, question) {
  const mime = /^data:([^;]+);/.exec(file.data)?.[1] || 'application/octet-stream';
  const part = mime.startsWith('audio/')
    ? { type: 'input_audio', input_audio: { data: file.data.split(',')[1], format: mime.split('/')[1].replace('mpeg', 'mp3').replace('x-wav', 'wav') } }
    : { type: 'file', file: { filename: file.name || 'file', file_data: file.data } };
  const kind = mime.startsWith('audio/') ? 'аудио' : mime.startsWith('video/') ? 'видео' : 'документ';
  const prompt = `Тебе прислали ${kind} «${file.name}». Перескажи его содержимое так, чтобы другой помощник мог ответить на вопрос, не видя файла.`
    + (kind === 'документ' ? ' Приведи основной текст документа как можно полнее.' : ' Если есть речь — расшифруй её дословно (на языке оригинала). Опиши, что видно и слышно, по порядку, с примерными метками времени.')
    + (question ? `\nВопрос собеседника: ${question}` : '');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, part] }] }),
    signal: AbortSignal.timeout(120e3),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`media ${r.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return String(j.choices?.[0]?.message?.content || '').trim();
}
