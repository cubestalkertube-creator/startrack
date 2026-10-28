# Сборка Linux-версии (Rust + CEF). Ubuntu 22.04 — ради старой glibc: собранное так запустится
# и на 22.04, и на всех более новых дистрибутивах.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config file \
      # то, что нужно libcef.so при запуске (и для проверки под xvfb)
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libxkbcommon0 libdrm2 libxshmfence1 libgtk-3-0 \
      xvfb xauth dbus-x11 socat \
      # AppImage
      squashfs-tools desktop-file-utils \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
