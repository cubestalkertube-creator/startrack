// Сборка APK для Android (телефоны arm64 и старые armv7):
//   node scripts/android.mjs [--x86_64]   → src-tauri/target/android/Startrack_<версия>.apk
// Нужны Android SDK + NDK (по умолчанию из %LOCALAPPDATA%\Android\Sdk) и JDK 17.
// APK подписывается ключом ~/.tauri/startrack-android.jks (настройки — startrack-android.properties рядом).
// С другим ключом телефон не поставит новую версию поверх старой — храните копию ключа.
//
// Почему не просто `tauri android build`: он кладёт собранную библиотеку в jniLibs символической
// ссылкой, а Windows без «Режима разработчика» их создавать не даёт. Поэтому Rust собираем через
// tauri (он настраивает NDK и встраивает интерфейс), на шаге ссылки он падает — библиотеку
// копируем сами и запускаем Gradle без его шагов сборки Rust.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (...p) => join(root, ...p);
const { version } = JSON.parse(readFileSync(at('package.json'), 'utf8'));

const sdk = process.env.ANDROID_HOME || join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const ndkDir = join(sdk, 'ndk');
const ndk = process.env.NDK_HOME || (existsSync(ndkDir) && join(ndkDir, spawnSync('cmd', ['/c', 'dir', '/b', '/o-n', ndkDir]).stdout.toString().split(/\r?\n/)[0]));
if (!existsSync(sdk) || !ndk || !existsSync(ndk)) {
  console.error(`Нет Android SDK/NDK: ${sdk}`);
  process.exit(1);
}
if (!existsSync(join(homedir(), '.tauri', 'startrack-android.properties'))) {
  console.error('Нет ключа подписи APK: ~/.tauri/startrack-android.properties');
  process.exit(1);
}
const env = { ...process.env, ANDROID_HOME: sdk, NDK_HOME: ndk };

const targets = [
  { tauri: 'aarch64', triple: 'aarch64-linux-android', abi: 'arm64-v8a', arch: 'arm64' },
  { tauri: 'armv7', triple: 'armv7-linux-androideabi', abi: 'armeabi-v7a', arch: 'arm' },
];
// --x86_64 — ещё и для эмулятора Android на ПК (для проверок; в релиз не нужен)
if (process.argv.includes('--x86_64')) targets.push({ tauri: 'x86_64', triple: 'x86_64-linux-android', abi: 'x86_64', arch: 'x86_64' });
const jni = at('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'jniLibs');

for (const t of targets) {
  console.log(`\n=== Rust → ${t.abi} ===`);
  const r = spawnSync(`npx tauri android build --apk --target ${t.tauri}`, { cwd: root, env, shell: true, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  const lib = at('src-tauri', 'target', t.triple, 'release', 'libstartrack_lib.so');
  // Главное — чтобы библиотека собралась для целевой архитектуры
  if (!existsSync(lib)) {
    console.error(`Не найдена собранная библиотека: ${lib}`);
    process.exit(1);
  }
  mkdirSync(join(jni, t.abi), { recursive: true });
  const dest = join(jni, t.abi, 'libstartrack_lib.so');
  rmSync(dest, { force: true });
  copyFileSync(lib, dest);
}

console.log('\n=== Gradle → APK ===');
const skip = ['rustBuildUniversalRelease', ...targets.map((t) => `rustBuild${t.arch[0].toUpperCase()}${t.arch.slice(1)}Release`)];
const g = spawnSync(`"${at('src-tauri', 'gen', 'android', 'gradlew.bat')}"`, ['assembleUniversalRelease', ...skip.flatMap((s) => ['-x', s]),
  `-PabiList=${targets.map((t) => t.abi).join(',')}`, `-ParchList=${targets.map((t) => t.arch).join(',')}`,
  `-PtargetList=${targets.map((t) => t.tauri).join(',')}`],
  { cwd: at('src-tauri', 'gen', 'android'), env, shell: true, stdio: 'inherit' });
if (g.status !== 0) process.exit(1);

const apk = at('src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release.apk');
const outDir = at('src-tauri', 'target', 'android');
mkdirSync(outDir, { recursive: true });
const final = join(outDir, `Startrack_${version}.apk`);
copyFileSync(apk, final);
console.log(`\nГотово: ${final}`);
