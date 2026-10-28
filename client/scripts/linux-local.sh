#!/bin/sh
# Сборка Linux-версии прямо на своём компьютере, без Docker:
#   sh scripts/linux-local.sh          → client/linux/target/release/startrack
#   sh scripts/linux-local.sh --run    → собрать и сразу запустить
# Нужны Rust (rustup), Node.js 20+, компилятор C/C++. Чего не хватает — скрипт скажет, как поставить.
# Chromium (CEF, ~300 МБ) скачивается при первой сборке в ~/.cache/startrack-cef, дальше берётся оттуда.
# Собранное так не обновляется само (это умеет только AppImage) — после git pull запустите скрипт снова.
set -e
cd "$(dirname "$0")/.."

# Подсказка, как поставить недостающее, — под пакетный менеджер дистрибутива
hint() {
  if command -v pacman >/dev/null; then echo "  sudo pacman -S --needed $1"
  elif command -v apt-get >/dev/null; then echo "  sudo apt install $2"
  elif command -v dnf >/dev/null; then echo "  sudo dnf install $3"
  elif command -v zypper >/dev/null; then echo "  sudo zypper install $3"
  fi
}
missing=0
need() {
  command -v "$1" >/dev/null && return
  echo "Не найдено: $1"
  missing=1
}
need cc
need c++
need make
need node
need npm
if [ $missing = 1 ]; then
  echo "Поставьте компилятор и Node.js:"
  hint "base-devel nodejs npm" "build-essential nodejs npm" "gcc gcc-c++ make nodejs npm"
fi
if ! command -v cargo >/dev/null; then
  echo "Не найдено: cargo. Поставьте Rust (https://rustup.rs):"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  missing=1
elif ! cargo --version >/dev/null 2>&1; then
  # cargo из пакета rustup есть, а сам Rust ещё не скачан
  echo "Rust не установлен:"
  echo "  rustup default stable"
  missing=1
fi
[ $missing = 1 ] && exit 1
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || {
  echo "Нужен Node.js 20 или новее, сейчас $(node --version)"
  # в Ubuntu 24.04 и Debian 12 из репозитория ставится 18
  if command -v apt-get >/dev/null; then
    echo "Свежий Node.js для Ubuntu/Debian:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt install nodejs"
  fi
  exit 1
}

# Интерфейс (client/dist) встраивается в бинарник
[ -d node_modules ] || npm install
npm run build

export CEF_PATH="${CEF_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/startrack-cef}"
mkdir -p "$CEF_PATH"
cd linux
cargo build --release
# libcef.so и остальные файлы Chromium cargo кладёт рядом с бинарником
BIN="${CARGO_TARGET_DIR:-$(pwd)/target}/release/startrack"
echo
echo "Готово: $BIN"
[ "$1" = "--run" ] && exec "$BIN"
exit 0
