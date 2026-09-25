# syntax=docker/dockerfile:1

# Pinned upstream versions. Bump these deliberately, never track a floating branch/tag.
#
# TIC80_VERSION is a commit SHA, not the v1.2.0 tag, because it needs a fix that landed
# on main after v1.2.0 and hasn't been cut into a tag yet: nesbox/TIC-80#3018 (merge
# commit 8bbaba17571e4b494ed60be38a9e733e92d24ac3, merged 2026-09-23) fixes the
# browser console's `add` command, which calls the now-unsupported Emscripten runtime
# helper `writeArrayToMemory` - newer Emscripten no longer includes it by default, so
# `add` throws a ReferenceError and never completes. Move this back to a tag once
# upstream cuts a release that includes this fix.
ARG TIC80_VERSION=8bbaba17571e4b494ed60be38a9e733e92d24ac3
ARG EMSDK_VERSION=6.0.10
ARG WEBDAV_IMAGE=hacdias/webdav:v5.16.0
ARG BASEIMAGE_ALPINE_TAG=3.21-6689918e-ls38

# ---------------------------------------------------------------------------
# Stage: build the official TIC-80 web/WASM player, unmodified, from source.
# We only ever consume tic80.js/tic80.wasm from this stage - never TIC-80's
# own build/html/index.html, which we replace with our own shell.
# ---------------------------------------------------------------------------
FROM emscripten/emsdk:${EMSDK_VERSION} AS tic80-builder
ARG TIC80_VERSION

RUN apt-get update && \
    apt-get install -y --no-install-recommends ninja-build gcc-multilib ruby && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init && \
    git remote add origin https://github.com/nesbox/TIC-80.git && \
    git fetch --depth 1 origin ${TIC80_VERSION} && \
    git checkout FETCH_HEAD && \
    git submodule update --init --recursive --depth 1

# Mirrors the "html" job of TIC-80's own .github/workflows/build.yml.
RUN mkdir -p build && cd build && \
    emcmake cmake -G Ninja \
        -DBUILD_SDLGPU=On \
        -DBUILD_STATIC=ON \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_WITH_ALL=ON \
        -DBUILD_PRO=On \
        -DCMAKE_EXE_LINKER_FLAGS="-sEXPORTED_RUNTIME_METHODS=FS" \
        .. && \
    cmake --build . --parallel

# ---------------------------------------------------------------------------
# Stage: extract the hacdias/webdav static binary.
# ---------------------------------------------------------------------------
FROM ${WEBDAV_IMAGE} AS webdav-extract

# ---------------------------------------------------------------------------
# Final image
# ---------------------------------------------------------------------------
FROM ghcr.io/linuxserver/baseimage-alpine:${BASEIMAGE_ALPINE_TAG}

RUN apk add --no-cache nginx openssl python3 py3-yaml

COPY --from=webdav-extract /bin/webdav /usr/local/bin/webdav
COPY --from=tic80-builder /src/build/bin/tic80.js /app/www/tic80.js
COPY --from=tic80-builder /src/build/bin/tic80.wasm /app/www/tic80.wasm

COPY web/ /app/www/
COPY root/ /

RUN mkdir -p /app/www /run/nginx && \
    chmod +x /usr/local/bin/webdav && \
    find /etc/s6-overlay/s6-rc.d \( -name run -o -name up \) -exec chmod +x {} \; && \
    chmod +x /etc/s6-overlay/scripts/*

VOLUME /config
EXPOSE 80
