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
# We consume tic80.js/tic80.wasm from this stage, plus TIC-80's own
# build/html/index.html, which the final stage patches (see below) so the page
# looks and behaves exactly like the official one.
#
# Pinned to linux/amd64 regardless of the final image's target platform: the
# output is WASM, not a native binary, so it's the same bytes either way, and
# building it requires gcc-multilib (32-bit x86 build tools - mirrors TIC-80's
# own html job, which likewise only ever builds on ubuntu-latest/amd64), which
# has no arm64 equivalent and can't be installed under arm64 emulation.
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 emscripten/emsdk:${EMSDK_VERSION} AS tic80-builder
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

# Which tic80.com site this build talks to. TIC-80 compiles that in (system.h: a release
# uses tic80.com, a dev snapshot dev.tic80.com), so it is read from the build itself
# instead of being a setting: a value that differed from the build could only be wrong.
# The version.h rule is cross-checked against the compiled engine, and the build fails if
# the two disagree (e.g. upstream changes how the host is chosen). The page's shim reads
# the result from config.js.
RUN release="$(sed -n 's/^#define TIC_VERSION_IS_RELEASE[[:space:]]*\([01]\).*/\1/p' build/version.h)" && \
    if [ "$release" = 1 ]; then host=tic80.com; elif [ "$release" = 0 ]; then host=dev.tic80.com; \
    else echo "cannot read TIC_VERSION_IS_RELEASE from build/version.h" >&2; exit 1; fi && \
    if grep -aq 'dev\.tic80\.com' build/bin/tic80.wasm; then built=dev.tic80.com; else built=tic80.com; fi && \
    [ "$host" = "$built" ] || { echo "version.h says $host but the compiled engine uses $built" >&2; exit 1; } && \
    printf 'window.CloudyTIC80Config = { upstream: "https://%s" };\n' "$host" > build/cloudytic80-config.js && \
    cat build/cloudytic80-config.js

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
COPY --from=tic80-builder /src/build/cloudytic80-config.js /app/www/config.js

# TIC-80's own page (click-to-play screen, touch controls, ...), with exactly three
# insertions: config.js and webdav-shim.js just before the <script> block that defines
# Module, and a one-line script right after that block installing the shim into Module.
# Nothing else about the page is ours. The block is found by what it defines, not by
# line numbers or formatting.
#
# WHAT A TIC80_VERSION BUMP CAN DO TO THIS, worst first. Only #4 and #5 stop the build;
# #1-#3 produce an image that builds and starts fine and then misbehaves, so after any bump
# run the browser smoke test at the bottom of this comment.
#
#  1. SILENT: the engine starts before our install script runs. Today the page injects
#     tic80.js only when the player clicks "CLICK TO PLAY", long after parsing has
#     finished, so the shim's FS hooks are always in place first. If upstream loads the
#     engine at page load instead (a plain <script src="tic80.js">, or injected from
#     inside the block that defines Module), the shim hooks the filesystem too late: no
#     carts are loaded from or saved to the server and they vanish on reload.
#  2. SILENT: the shim's own assumptions about TIC-80 change - Module.FS still being
#     exported (the -sEXPORTED_RUNTIME_METHODS=FS flag above), FS.mount / FS.syncfs still
#     being how the cart folder is mounted and persisted (see the header of
#     web/webdav-shim.js). A page-level patch can't see any of that.
#  3. SILENT: TIC-80 starts requesting new paths from "its own site". The shim only
#     redirects /json, /cart/, /export/ and /js/ (UPSTREAM_PATHS in webdav-shim.js) to
#     the build's tic80.com site; any other relative path lands on this server and 404s.
#  4. LOUD: release vs snapshot. The site TIC-80 talks to (tic80.com for a release,
#     dev.tic80.com for a snapshot) is read from the build's own version.h and
#     cross-checked against the compiled engine in the config.js step above. It follows
#     TIC80_VERSION automatically; the build fails if the two ever disagree.
#  5. LOUD (the build fails at the RUN below, naming the problem): Module is no longer
#     defined exactly once with var/let/const inside an inline <script> block - it was
#     renamed, defined twice, moved to an external .js file, or built at runtime - or
#     build/html/index.html moved (the COPY fails).
#  Harmless: reindenting, attributes on <script>, CRLF, the Module object spread over
#  several lines, other code added around it, new CSS/markup/touch controls.
#
# Smoke test after a bump (browser, logged in): the CLICK TO PLAY screen appears and
# the engine only loads after the click; `save x` makes a PUT /dav/x.tic and a reload
# lists the cart again; `surf` lists carts from the build's site; `add` opens its dialog;
# `export html x.zip` saves a valid zip to the server.
COPY --from=tic80-builder /src/build/html/index.html /app/www/index.html
RUN python3 - <<'PYEOF'
import re
path = '/app/www/index.html'
html = open(path, encoding='utf-8').read().replace('\r\n', '\n')

defs = list(re.finditer(r'\b(?:var|let|const)\s+Module\s*=', html))
assert len(defs) == 1, 'upstream index.html: expected exactly one definition of Module, found %d' % len(defs)

# The <script> block around it: its opening tag, and the first closing tag after it.
open_tag = html.rfind('<script', 0, defs[0].start())
assert open_tag != -1 and '</script>' not in html[open_tag:defs[0].start()], \
    'upstream index.html: Module is not defined inside a <script> block'
close_tag = html.find('</script>', defs[0].end())
assert close_tag != -1, 'upstream index.html: the <script> block defining Module is never closed'
close_tag += len('</script>')

# Insert the later position first so the earlier one is not shifted.
html = html[:close_tag] + '\n    <script>CloudyTIC80Shim.install(Module);</script>' + html[close_tag:]
html = (html[:open_tag]
        + '<script src="config.js"></script>\n    <script src="webdav-shim.js"></script>\n    '
        + html[open_tag:])

open(path, 'w', encoding='utf-8', newline='\n').write(html)
PYEOF

COPY web/ /app/www/
COPY root/ /

RUN mkdir -p /app/www /run/nginx && \
    chmod +x /usr/local/bin/webdav /usr/local/bin/healthcheck && \
    find /etc/s6-overlay/s6-rc.d \( -name run -o -name up \) -exec chmod +x {} \; && \
    chmod +x /etc/s6-overlay/scripts/*

# Make a failed init (unreadable webdav-config.yml, ...) stop the
# container instead of leaving it half-running.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2

VOLUME /config
EXPOSE 80

# Healthy only when every service in the container is up and answering -
# see /usr/local/bin/healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/healthcheck"]
