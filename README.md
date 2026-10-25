# Startrack

Лёгкий мессенджер в духе Discord для Windows: друзья, личные сообщения, голосовые звонки и демонстрация экрана до 1440p 60 fps.

## Скачать

Установщик (~1.4 МБ) — в разделе [Releases](../../releases/latest): `Startrack_x.y.z_x64-setup.exe`.
Нужна Windows 10/11 (WebView2 уже есть в системе).

## Возможности

- Регистрация, заявки в друзья, статус «в сети»
- Личные сообщения в реальном времени
- Звонки другу: микрофон вкл/выкл, выключение звука, выбор микрофона и вывода, шумоподавление
- Демонстрация всего экрана или отдельного окна со звуком системы: 720p30 … 1440p60, H.264 (аппаратный) / VP9 / AV1, режимы «плавность» и «чёткость»
- Работает с включённым VPN (Happ, Clash, WireGuard…): к своему серверу приложение ходит мимо туннеля
  (локальный пересыльщик на Rust, привязанный к физическому адаптеру), а при VPN сразу звонит через TURN/TLS на 443
- Звонок переживает обрывы: переподключение без потери микрофона и демонстрации экрана
- Общая мелодия звонка с сервера (файл `/opt/startrack/data/ringtone.mp3`, отдаётся только вошедшим) и своя мелодия у каждого (🔔 внизу слева)

## Стек

| Часть | Технологии |
|---|---|
| Клиент | Tauri 2 (Rust + WebView2), TypeScript, Vite |
| Звонки | LiveKit (WebRTC SFU), Opus + RED, H.264/VP9/AV1 |
| Сервер | Node.js 24, `node:sqlite`, WebSocket |
| Вход | Caddy (TLS, Let's Encrypt) с layer4: SNI-разделение 443 между сайтом и TURN |

```
client/   Tauri-приложение (src/ — интерфейс, src-tauri/ — нативная оболочка)
server/   API: аккаунты, друзья, сообщения, сигналинг звонков, токены LiveKit
deploy/   setup.sh — установка на Linux-сервер в /opt/startrack без Docker
```

## Сборка клиента

Нужны Node.js 20+, Rust (MSVC) и Visual Studio Build Tools (C++).

```bash
cd client
npm install
npx tauri dev      # разработка
npx tauri build    # установщик в src-tauri/target/release/bundle/nsis/
```

Адрес сервера по умолчанию задан в `client/src/main.ts`, его можно поменять на экране входа («Сервер»).

## Развёртывание сервера

На сервере (Ubuntu) в `/opt/startrack` должны лежать `node/` (Node.js 24), `bin/livekit-server`,
`bin/caddy` (сборка с модулем `github.com/mholt/caddy-l4`) и папка `server/`. Затем:

```bash
cp deploy/setup.sh deploy/.env.example /opt/startrack/
sh /opt/startrack/setup.sh
```

Скрипт сам создаст `.env` со случайными секретами, конфиги LiveKit и Caddy и systemd-службы
`startrack-api`, `startrack-livekit`, `startrack-caddy`. Порты: 80, 443 (TCP), 7881 (TCP), 50000–50200 (UDP).
