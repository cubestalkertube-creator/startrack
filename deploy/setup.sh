#!/bin/sh
# Ставит/обновляет Startrack в /opt/startrack без Docker (на сервере крутится VPN, iptables не трогаем).
# Ожидает: /opt/startrack/{node,bin/livekit-server,server}. Запуск: sh /opt/startrack/setup.sh
set -e
cd /opt/startrack
[ -f .env ] || {
  cp .env.example .env
  sed -i "s/^APP_SECRET=.*/APP_SECRET=$(openssl rand -hex 32)/; s/^LK_SECRET=.*/LK_SECRET=$(openssl rand -hex 32)/; s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 24)/" .env
}
# .env до появления админки: дописываем токен
grep -q '^ADMIN_TOKEN=' .env || echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
. ./.env
TURN_TLS_PORT=${TURN_TLS_PORT:-5349}
CERT_DIR=/opt/startrack/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.${DOMAIN}
cat > livekit.yaml <<EOF
port: ${LK_PORT}
rtc:
  tcp_port: ${LK_TCP_PORT}
  port_range_start: ${LK_UDP_START}
  port_range_end: ${LK_UDP_END}
  node_ip: ${PUBLIC_IP}
  use_external_ip: false
keys:
  ${LK_KEY}: ${LK_SECRET}
logging:
  level: info
# TURN только поверх TLS: запасной путь для клиентов за VPN/TUN, где UDP рвётся
turn:
  enabled: true
  domain: turn.${DOMAIN}
  tls_port: ${TURN_TLS_PORT}
  udp_port: 0
  external_tls: false
  cert_file: ${CERT_DIR}/turn.${DOMAIN}.crt
  key_file: ${CERT_DIR}/turn.${DOMAIN}.key
EOF
chmod 600 .env livekit.yaml

# Порт 443 делим по SNI (caddy-l4): turn.* -> TURN/TLS LiveKit (он всегда объявляет turns на :443),
# остальное -> HTTPS-сайт (API + LiveKit-сигналинг /rtc, /twirp). Сертификаты Caddy берёт через HTTP-01 на :80.
cat > Caddyfile <<EOF
{
  layer4 {
    :443 {
      @turn tls sni turn.${DOMAIN}
      route @turn {
        proxy 127.0.0.1:${TURN_TLS_PORT}
      }
      route {
        proxy 127.0.0.1:8443
      }
    }
  }
}

${DOMAIN}:8443 {
  bind 127.0.0.1
  @lk path /rtc* /twirp*
  reverse_proxy @lk 127.0.0.1:${LK_PORT}
  reverse_proxy 127.0.0.1:${API_PORT}
}

# :80 — для HTTP-01 проверок Let's Encrypt (443 занят layer4)
http://${DOMAIN}, http://turn.${DOMAIN} {
  redir https://{host}{uri}
}

# только чтобы Caddy выпускал и продлевал сертификат для TURN
turn.${DOMAIN}:8444 {
  bind 127.0.0.1
  respond 404
}
EOF

cat > /etc/systemd/system/startrack-caddy.service <<EOF
[Unit]
Description=Startrack HTTPS proxy (Caddy)
After=network-online.target
[Service]
Environment=XDG_DATA_HOME=/opt/startrack/caddy XDG_CONFIG_HOME=/opt/startrack/caddy
ExecStart=/opt/startrack/bin/caddy run --config /opt/startrack/Caddyfile --adapter caddyfile
Restart=always
[Install]
WantedBy=multi-user.target
EOF

(cd server && ../node/bin/node ../node/lib/node_modules/npm/bin/npm-cli.js install --omit=dev --no-fund --no-audit)

cat > /etc/systemd/system/startrack-livekit.service <<EOF
[Unit]
Description=Startrack LiveKit SFU
After=network-online.target
[Service]
ExecStart=/opt/startrack/bin/livekit-server --config /opt/startrack/livekit.yaml
Restart=always
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/startrack-api.service <<EOF
[Unit]
Description=Startrack API
After=network-online.target startrack-livekit.service
[Service]
WorkingDirectory=/opt/startrack/server
Environment=HOST=127.0.0.1 PORT=${API_PORT} DATA_DIR=/opt/startrack/data APP_SECRET=${APP_SECRET}
Environment=LIVEKIT_URL=wss://${DOMAIN} LIVEKIT_API_KEY=${LK_KEY} LIVEKIT_API_SECRET=${LK_SECRET}
Environment=ADMIN_TOKEN=${ADMIN_TOKEN} ADMIN_PORT=${ADMIN_PORT:-8081}
ExecStart=/opt/startrack/node/bin/node src/index.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# Caddy продлил сертификат -> перезапускаем LiveKit, чтобы TURN взял новый
cat > /etc/systemd/system/startrack-cert.path <<EOF
[Path]
PathChanged=${CERT_DIR}/turn.${DOMAIN}.crt
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/startrack-cert.service <<EOF
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart startrack-livekit
EOF

systemctl daemon-reload
systemctl enable startrack-caddy && systemctl restart startrack-caddy
# LiveKit нужен сертификат для TURN/TLS: ждём, пока Caddy его получит
for i in $(seq 1 60); do [ -f "${CERT_DIR}/turn.${DOMAIN}.crt" ] && break; sleep 2; done
systemctl enable --now startrack-livekit startrack-api startrack-cert.path
systemctl restart startrack-livekit startrack-api
sleep 2
systemctl --no-pager --lines=0 status startrack-livekit startrack-api startrack-caddy | grep -E "Active|startrack"
