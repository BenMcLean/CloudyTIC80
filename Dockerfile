# syntax=docker/dockerfile:1

# Pinned upstream versions. Bump these deliberately, never track a floating branch/tag.
ARG TIC80_VERSION=v1.2.0
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
RUN git clone --branch ${TIC80_VERSION} --depth 1 --recurse-submodules \
        https://github.com/nesbox/TIC-80.git .

# Mirrors the "html" job of TIC-80's own .github/workflows/build.yml.
# PRO is built unconditionally - this image only ever produces the Pro edition, not a
# choice exposed at build time.
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
