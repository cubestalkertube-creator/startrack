// Выпуск новой версии с автообновлением.
//   node scripts/release.mjs 0.1.5 notes.md            — поднять версию, собрать, подписать, сделать latest.json
//   node scripts/release.mjs 0.1.5 notes.md --publish  — то же, закоммитить версию, запушить и выложить релиз на GitHub
// Установленные клиенты при запуске смотрят latest.json последнего релиза и сами ставят новую версию.
// Нужен ключ подписи ~/.tauri/startrack-updater.key (или путь в TAURI_SIGNING_PRIVATE_KEY).
// Без него (или с другим ключом) обновления не установятся — храните его копию в надёжном месте.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [version, notesFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const publish = process.argv.includes('--publish');
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Использование: node scripts/release.mjs <версия x.y.z> [файл с описанием] [--publish]');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : `Startrack ${version}`;

const key = process.env.TAURI_SIGNING_PRIVATE_KEY || join(homedir(), '.tauri', 'startrack-updater.key');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key)) {
  console.error(`Нет ключа подписи обновлений: ${key}`);
  process.exit(1);
}

// версия живёт в трёх местах
const edit = (file, fn) => writeFileSync(at(file), fn(readFileSync(at(file), 'utf8')));
edit('package.json', (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit('src-tauri/tauri.conf.json', (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));

const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
run('npx tauri build', { TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' });

const dir = at('src-tauri/target/release/bundle/nsis');
const exe = `Startrack_${version}_x64-setup.exe`;
const repo = 'cubestalkertube-creator/startrack';
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(dir, exe + '.sig'), 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${exe}`,
    },
  },
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nГотово: ${dir}\\${exe} (+ .sig, latest.json)`);

if (publish) {
  const files = 'package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock';
  run(`git add ${files}`);
  if (execSync('git diff --cached --name-only', { cwd: root }).toString().trim()) run(`git commit -m "Startrack ${version}" -- ${files}`);
  run('git push');
  const notesPath = join(dir, 'notes.md');
  writeFileSync(notesPath, notes + '\n');
  run(`gh release create v${version} --repo ${repo} --title "Startrack ${version}" --notes-file "${notesPath}" ` +
    `"${join(dir, exe)}" "${join(dir, exe + '.sig')}" "${join(dir, 'latest.json')}"`);
  console.log('Релиз опубликован — клиенты обновятся при следующем запуске.');
} else {
  console.log('Чтобы выложить на GitHub, запустите то же самое с --publish.');
}
