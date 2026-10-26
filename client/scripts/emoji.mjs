// Собирает данные для выбора эмодзи (src/emoji.json) и кладёт шрифт Twemoji в src/assets.
// Запуск: node scripts/emoji.mjs (нужны devDependencies emojibase-data и @sableclient/twemoji-font)
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ru = require('emojibase-data/ru/compact.json');
const en = new Map(require('emojibase-data/en/data.json').map((e) => [e.hexcode, e]));
const codes = ['iamcal', 'github', 'emojibase'].map((s) => require(`emojibase-data/en/shortcodes/${s}.json`));
const fontDir = require.resolve('@sableclient/twemoji-font').replace(/index\.css$/, '');

// Какие символы есть в шрифте — по его unicode-range; остальное (новее шрифта) не показываем
const ranges = [...readFileSync(fontDir + 'index.css', 'utf8').matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/gi)]
  .map((m) => [parseInt(m[1], 16), parseInt(m[2] || m[1], 16)]);
const covered = (s) => [...s].every((ch) => { const c = ch.codePointAt(0); return ranges.some(([a, b]) => c >= a && c <= b); });

// Как в Discord: смайлики и люди — одна категория
const GROUPS = ['Люди', 'Природа', 'Еда', 'Занятия', 'Путешествия', 'Предметы', 'Символы', 'Флаги'];
const groupOf = { 0: 0, 1: 0, 3: 1, 4: 2, 5: 4, 6: 3, 7: 5, 8: 6, 9: 7 };

const list = [];
for (const e of ru.sort((a, b) => a.order - b.order)) {
  const g = groupOf[e.group];
  const full = en.get(e.hexcode);
  if (g === undefined || !full || full.version > 17 || !covered(e.unicode)) continue;
  const names = [...new Set(codes.flatMap((c) => [c[e.hexcode] ?? []].flat()))];
  if (!names.length) names.push(full.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const words = [...new Set([e.label, ...(e.tags || []), full.label].join(' ').toLowerCase().split(/[\s:,()«»"]+/).filter(Boolean))];
  const row = [e.unicode, g, names.join(' '), words.join(' ')];
  // оттенки кожи: только «одинаковые» (у рукопожатия и пар их 25 — берём 5 одноцветных)
  const skins = (full.skins || []).filter((s) => typeof s.tone === 'number' && covered(s.emoji)).map((s) => s.emoji);
  if (skins.length === 5) row.push(skins);
  list.push(row);
}

writeFileSync(new URL('../src/emoji.json', import.meta.url), JSON.stringify({ groups: GROUPS, list }));
mkdirSync(new URL('../src/assets/', import.meta.url), { recursive: true });
copyFileSync(fontDir + 'files/twemoji.woff2', new URL('../src/assets/twemoji.woff2', import.meta.url));
// лицензия шрифта и графики Twemoji (CC-BY 4.0 требует указать авторство)
copyFileSync(fontDir + '../LICENSE.md', new URL('../src/assets/twemoji-LICENSE.md', import.meta.url));
console.log(`emoji.json: ${list.length} эмодзи`);
