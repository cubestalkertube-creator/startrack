// Сборка Linux-версии (AppImage):
//   node scripts/linux.mjs   → src-tauri/target/linux/Startrack_<версия>_x86_64.AppImage
// Нужен Docker (на Windows — Docker Desktop). Интерфейс собирается здесь (npm run build), а Rust и
// Chromium (CEF) — в контейнере на Ubuntu 22.04, чтобы AppImage запускался и на старых, и на новых
// дистрибутивах. Кэш Cargo, сборки и архива CEF (~300 МБ) живёт в томах Docker startrack-*,
// так что долгой бывает только первая сборка.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (cmd, args = []) => {
  // npm на Windows — это npm.cmd, его запускает только оболочка
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: !args.length });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npm run build');
run('docker', ['build', '-t', 'startrack-linux-build', join(root, 'linux')]);
run('docker', [
  'run', '--rm',
  '-v', `${root}:/src`,
  '-v', 'startrack-cargo:/opt/cargo/registry',
  '-v', 'startrack-target:/target',
  '-v', 'startrack-cef:/cef',
  '-e', 'CARGO_TARGET_DIR=/target',
  '-e', 'CEF_PATH=/cef',
  'startrack-linux-build', 'sh', '/src/linux/build-in-docker.sh',
]);
console.log(`\nГотово: ${join(root, 'src-tauri', 'target', 'linux', `Startrack_${version}_x86_64.AppImage`)}`);
