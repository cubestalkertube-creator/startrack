#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! pkg-config --atleast-version=4.8 gtk4; then
  echo "Нужен GTK 4.8+. Установите зависимости из client/README.md."
  exit 1
fi
cargo build --release --locked
if [ "${1:-}" = "--run" ]; then exec target/release/startrack; fi
echo "Готово: $(pwd)/target/release/startrack"
