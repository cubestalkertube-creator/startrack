#!/bin/sh
# Usage: sh /opt/startrack/update.sh 0.1.34 /opt/startrack/releases/0.1.34.tar.gz
# Archive contains server/src and client/dist, never .env or user data.
set -eu
version=${1:?version required}
archive=${2:?archive required}
case "$version" in *[!0-9.]*|'') echo 'Invalid version' >&2; exit 1;; esac
cd /opt/startrack
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/opt/startrack/backups/update-$version-$stamp"
stage="/opt/startrack/releases/stage-$version-$stamp"
mkdir -p "$backup" "$stage"
tar -czf "$backup/source.tar.gz" server/src
if [ -d web ]; then tar -czf "$backup/web.tar.gz" web; fi
BACKUP_PATH="$backup/database.sqlite" /opt/startrack/node/bin/node --input-type=module -e '
  import {DatabaseSync} from "node:sqlite";
  const db=new DatabaseSync("/opt/startrack/data/startrack.db");
  db.exec("PRAGMA busy_timeout=15000");
  db.prepare("VACUUM INTO ?").run(process.env.BACKUP_PATH);
  db.close();
'
tar -xzf "$archive" -C "$stage"
test -f "$stage/server/src/index.js"
test -f "$stage/client/dist/index.html"
for f in "$stage"/server/src/*.js; do /opt/startrack/node/bin/node --check "$f"; done
cp -a "$stage/server/src/." server/src/
mkdir -p web/assets
cp -a "$stage/client/dist/assets/." web/assets/
cp "$stage/client/dist/index.html" web/index.html.next
mv web/index.html.next web/index.html
printf '{"version":"%s"}\n' "$version" > web/version.json
systemctl restart startrack-api
for n in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null && curl -fsS http://127.0.0.1:8080/app | grep -q 'Startrack'; then
    printf 'Deployed Startrack %s. Backup: %s\n' "$version" "$backup"
    exit 0
  fi
  sleep 1
done
echo 'Health check failed; restoring previous API and browser client' >&2
tar -xzf "$backup/source.tar.gz" -C /opt/startrack
if [ -f "$backup/web.tar.gz" ]; then tar -xzf "$backup/web.tar.gz" -C /opt/startrack; fi
systemctl restart startrack-api
exit 1
