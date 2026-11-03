// Isolated local backend. Optional --use-server-model reads only model configuration over SSH;
// credentials stay in process memory. No deployment, remote writes or production database access.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, HOST: '127.0.0.1', PORT: '18080', DATA_DIR: join(root, 'data', 'local-preview') };
if (process.argv.includes('--use-server-model')) {
  try {
    const config = execFileSync('ssh', ['-i', join(homedir(), '.ssh', 'startrack_ed25519'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'root@185.218.0.111', "sed -n '/^POLZA_/p; /^VERITY_/p' /opt/startrack/.env"], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    for (const line of config.split(/\r?\n/)) {
      const m = /^((?:POLZA|VERITY)_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { console.error('Не удалось прочитать настройки модели по SSH. Можно передать POLZA_API_KEY через окружение.'); process.exit(1); }
}
const server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
server.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => { server.kill(); process.exit(0); });
const base = 'http://127.0.0.1:18080';
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(base + '/health')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const api = async (path, body, token = '') => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
async function account(username) {
  const body = { username, password: 'local-preview-only' };
  try { return await api('/api/register', body); } catch { return api('/api/login', body); }
}
const author = await account('preview_author'), friend = await account('preview_friend');
try { await api('/api/friends/request', { username: friend.user.username }, author.token); } catch {}
await api('/api/friends/accept', { userId: author.user.id }, friend.token);
const apps = (await api('/api/apps', undefined, author.token)).apps;
if (!apps.some((a) => a.published)) {
  const app = await api('/api/apps/save', { name: 'Кликер', description: 'Небольшая игра для проверки публикации и запуска в беседе', html: '<style>body{background:#1e1f22;color:#f2f3f5;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center}button{border:0;border-radius:8px;background:#5865f2;color:white;font:inherit;padding:14px 28px}</style><div><h1>Кликер</h1><p id="score">Счёт: 0</p><button onclick="document.getElementById(\'score\').textContent=\'Счёт: \'+ ++window.score">Нажми меня</button></div><script>window.score=0</script>' }, author.token);
  const published = await api('/api/apps/publish', { id: app.id }, author.token);
  await api('/api/dm/messages', { peer: friend.user.id, text: '/app ' + published.slug }, author.token);
}
console.log(`Локальная проверка: ${base}. Модель: ${env.POLZA_API_KEY ? 'подключена' : 'ключ не задан'}.`);
console.log('Тестовые аккаунты: preview_author / preview_friend, пароль: local-preview-only.');
if (process.argv.includes('--launch')) {
  const exe = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Startrack', 'startrack.exe');
  const app = spawn(exe, ['--local-preview'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, STARTRACK_PREVIEW_TOKEN: author.token } });
  app.on('error', () => console.error('Не удалось открыть установленный Startrack. Сначала установите локальную сборку.'));
  app.unref();
}
