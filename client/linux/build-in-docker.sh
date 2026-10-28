#!/bin/sh
# Сборка AppImage внутри контейнера startrack-linux-build (запускает scripts/linux.mjs).
# /src — папка client, интерфейс в /src/dist уже собран. Результат:
# /src/src-tauri/target/linux/Startrack_<версия>_x86_64.AppImage
set -e
cd /src/linux
cargo build --release
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)
REL="${CARGO_TARGET_DIR:-target}/release"

APPDIR=/tmp/Startrack.AppDir
LIB="$APPDIR/usr/lib/startrack"
rm -rf "$APPDIR"
mkdir -p "$LIB/locales"
cp "$REL/startrack" "$LIB/"
for f in libcef.so libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json icudtl.dat v8_context_snapshot.bin \
         resources.pak chrome_100_percent.pak chrome_200_percent.pak; do
  [ -e "$REL/$f" ] && cp "$REL/$f" "$LIB/"
done
# libEGL/libGLESv2 есть не во всех версиях CEF
for f in "$REL"/libEGL.so "$REL"/libGLESv2.so; do [ -e "$f" ] && cp "$f" "$LIB/"; done
# интерфейс на русском, en-US — запасной
cp "$REL/locales/ru.pak" "$REL/locales/en-US.pak" "$LIB/locales/"
# в libcef.so из архива CEF отладочные символы — без них он в несколько раз меньше
strip --strip-unneeded "$LIB/libcef.so" "$LIB/libvk_swiftshader.so"

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/lib/startrack/startrack" "$@"
EOF
chmod +x "$APPDIR/AppRun"
cp ../src-tauri/icons/128x128@2x.png "$APPDIR/startrack.png"
cp "$APPDIR/startrack.png" "$APPDIR/.DirIcon"
cat > "$APPDIR/startrack.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Startrack
Comment=Мессенджер: друзья, сообщения, звонки и демонстрация экрана
Exec=startrack %U
Icon=startrack
Categories=Network;InstantMessaging;Chat;
Terminal=false
X-AppImage-Version=$VERSION
EOF

# appimagetool (своей версии рантайм внутри: libfuse2 на компьютере не нужен)
TOOL=/opt/cargo/appimagetool-1.9.1
if [ ! -x "$TOOL" ]; then
  curl -sSfL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
OUT=/src/src-tauri/target/linux
mkdir -p "$OUT"
ARCH=x86_64 "$TOOL" --appimage-extract-and-run --no-appstream "$APPDIR" "$OUT/Startrack_${VERSION}_x86_64.AppImage"
ls -la "$OUT"
# в CI папка принадлежит не root — возвращаем владельца, чтобы рядом можно было положить подпись
chown -R "$(stat -c %u:%g /src)" "$OUT" Cargo.lock 2>/dev/null || true
