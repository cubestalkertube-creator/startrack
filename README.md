# Startrack

Нативный мессенджер для Windows/Linux на Rust и gtk-rs (GTK 4): друзья, личные и групповые сообщения, профили, файлы и голосовые звонки через нативный LiveKit/WebRTC.

Клиент больше не использует TypeScript, JavaScript, Vite, Tauri, CEF или WebView. Сервер пока остаётся на Node.js 24 и SQLite, протокол API сохранён.

## Сборка клиента

Инструкции, проверки и границы первого этапа — в [client/README.md](client/README.md).

```powershell
./client/scripts/setup-gtk.ps1
./client/scripts/gtk-env.ps1 -Run
./client/scripts/build.ps1 -Release -Package
```

Linux: `sh client/scripts/linux-local.sh --run` (GTK 4.8+ и зависимости из инструкции).

Контекстные меню по правой кнопке мыши и Shift+F10 доступны у сообщений, бесед и участников звонка. Чужие сообщения удалять нельзя.

Нативная версия Windows/Linux включает обрезку изображений, трей/автозапуск, инструменты Верити, системный звук демонстрации и подписанные обновления. Android и встроенные YouTube/Spotify отложены по договорённости. Ограничения и проверки перечислены в инструкции клиента. Старые опубликованные релизы относятся к прежнему клиенту.

```
client/   нативный Rust/GTK-клиент, Cargo.toml, src/, scripts/, tests/
server/   прежний Node.js API, SQLite, WebSocket, выдача токенов LiveKit
deploy/   установка сервера на Linux без Docker
```

## Сервер (Ubuntu, 185.218.0.111)

Всё ставит скрипт deploy/setup.sh. Без Docker, потому что на этом сервере работает ваш VPN и iptables трогать нельзя.

В /opt/startrack должны лежать node/ (Node.js 24), bin/livekit-server, bin/caddy (сборка с модулем caddy-l4), папка server/, а также setup.sh и .env.example. Их копируют из deploy/.
Запуск: sh /opt/startrack/setup.sh.
Скрипт создаёт .env со случайными APP_SECRET, LK_SECRET и ADMIN_TOKEN, если файла ещё нет. Затем генерирует livekit.yaml и Caddyfile, ставит npm-зависимости сервера и заводит три systemd-службы: startrack-api, startrack-livekit, startrack-caddy. Есть ещё startrack-cert.path, который перезапускает LiveKit после продления TURN-сертификата.
Caddy на 443 разделяет трафик по SNI: turn.* уходит в TURN/TLS LiveKit, остальное на сайт и API.
Порты: 80 и 443 (TCP), 7881 (TCP), 50000–50200 (UDP).

Для правок одного только API, по заметкам в памяти, достаточно скопировать server/src/index.js и перезапустить startrack-api. Полный setup.sh перезапускает и Caddy, и LiveKit, поэтому активные звонки обрываются.

## Админка

Отдельный порт `127.0.0.1:8081` в том же процессе API, наружу не открыт (Caddy его не проксирует).
Пользователи (поиск, карточка без текста переписки), сброс пароля, бан, «выйти везде», удаление аккаунта
(с автоматическим бэкапом базы), статистика и место на диске, мелодия звонка, бэкапы, журнал действий.

```bash
ssh -i ~/.ssh/startrack_ed25519 -N -L 8081:127.0.0.1:8081 root@185.218.0.111
```

Потом открыть http://localhost:8081 и ввести `ADMIN_TOKEN` из `/opt/startrack/.env`.
