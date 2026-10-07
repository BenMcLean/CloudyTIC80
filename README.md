# CloudyTIC80

A Docker image that serves the official [TIC-80](https://github.com/nesbox/TIC-80) fantasy
console - web/WASM build, pinned to a specific upstream version - but
redirects cart storage (`load`/`save`/`files`/`folder`) from the browser's local
IndexedDB to per-user folders on the server, behind Basic Auth. Multiple accounts are
supported; each user only ever sees their own carts.

TIC-80 itself is never forked or patched. This works by loading the official,
unmodified `tic80.js`/`tic80.wasm` build inside our own small HTML shell, plus a JS
shim that hooks Emscripten's virtual filesystem calls TIC-80 already makes, and
redirects them to a WebDAV server over HTTP.

## Why this exists

For a classroom setting, this provides a fast way for students to login and have their carts, plus anything the teacher decides to send them, already there. Putting a server behind TIC-80 provides the convenience to be able to work remotely from anywhere. The name is a convention following my previous projects, [CloudyDoom](https://github.com/BenMcLean/CloudyDoom) and [CloudyQuake](https://github.com/BenMcLean/CloudyQuake).

## How it works

```
                 ┌────────────────────────────────────────────────┐
 browser ──────▶ │ nginx :80  — auth_basic ON for everything       │
 (Basic Auth     │  except /favicon.ico                            │
  prompted       │  ├─ /favicon.ico → static, auth_basic off       │
  immediately    │  ├─ /            → static: index.html,          │
  on page load,  │  │                 tic80.js/.wasm, shim.js      │
  before TIC-80  │  └─ /dav/*       → proxy_pass → webdav:6065     │
  even loads)    │      (Authorization header forwarded as-is)     │
                 │                                                  │
                 │ hacdias/webdav :6065                             │
                 │  - Basic Auth (webdav-config.yml)                │
                 │  - per-user directory scope /config/data/<u>     │
                 └────────────────────────────────────────────────┘
```

- **The whole site is gated behind Basic Auth**, except `/favicon.ico` — deliberately,
  so nobody can start a project unauthenticated and only discover later that it was
  never being saved.
- **The page is TIC-80's own** (`build/html/index.html`: click-to-play screen, touch
  controls, layout), taken from the same build as the engine, with exactly three
  insertions made at image build time: `config.js` and `webdav-shim.js` before the
  script block that defines `Module`, and a one-line script after it that installs the
  shim. The block is found by what it defines, not by its formatting, so it follows
  upstream whenever `TIC80_VERSION` moves. If that block ever disappears the build
  fails, rather than shipping a page that doesn't save.
- **`web/webdav-shim.js`** is loaded before TIC-80's own compiled code runs. It hooks
  Emscripten's virtual filesystem (`Module.FS`), which TIC-80 uses for carts, and makes the
  server the only source of truth: **every file operation goes to the server, every time,
  and fails if the server can't do it.**
  - Open for reading = `GET`; `stat`/`ls`/`dir` = `PROPFIND` (a cart dropped into a user's
    folder appears at once, one removed disappears); delete = `DELETE`; new folder =
    `MKCOL`; rename = `MOVE`. The in-browser filesystem is just a scratch mirror,
    refreshed from the server on each call and never used as a fallback.
  - Saving probes the server before the file is opened (TIC-80 reports a failed save only
    if the open fails), then uploads the content when the file is closed and checks the
    server holds it. If that fails, the local file is put back as it was.
  - Any failure to talk to the server (unreachable, 5xx, login lost, ...) makes the
    operation fail with an I/O error and shows a red banner (`NOT SAVED...` /
    `COULD NOT READ FROM THE SERVER...`) that stays until an operation of that kind
    succeeds. Plain "not found" answers (e.g. `load` of a cart that doesn't exist) are
    reported to TIC-80 as that, without a banner. Operations that can't be done on the
    server (truncate, links) fail rather than quietly diverging.
  - The reserved `.local` folder (TIC-80's own settings and cache of tic80.com carts) is
    not the user's work and stays purely in the browser.
  - Because these are synchronous requests, a slow connection makes the console pause
    during an operation rather than lose it.
- **Option defaults.** TIC-80's own defaults are overridden when the page starts, from
  `/config/tic80-options.json` (seeded on first start, next to `webdav-config.yml`; edit it
  and reload the page, no restart needed):

  ```json
  {
    "defaults": { "crt": false },
    "forced":   { "tabMode": 1, "tabSize": 4 }
  }
  ```

  `defaults` apply only until a browser has saved options of its own, so a user's later
  choice sticks. `forced` apply on every start, so a change made in TIC-80's options menu
  lasts one session. The keys are TIC-80's own option names: `crt`, `fullscreen`, `vsync`,
  `integerScale`, `volume` (0-15), `autosave`, `keybindMode`, `tabMode` (0 auto, 1 tabs,
  2 spaces) and `tabSize`. A key you leave out keeps TIC-80's own default. If the file is
  deleted, built-in defaults (the ones above) apply; if it is not valid, the page shows a
  banner saying so. TIC-80 keeps options per browser, not per account.
- **hacdias/webdav** is the actual storage backend: it validates Basic Auth and scopes
  each user strictly to their own directory. This has been tested directly against
  path-traversal attempts (`../`, URL-encoded `..%2f`, encoded slashes, etc.) — nginx
  normalizes dot-segments in the URL before matching the `/dav/` location at all, and
  even a path that survives normalization and reaches webdav is still resolved *within
  the authenticated user's own scoped directory* by webdav itself, never outside it.
  One user cannot read, list, or write another user's files under any tried
  combination.
- **nginx** serves the static TIC-80 assets and reverse-proxies `/dav/*` to webdav.
  Because both share one origin, the browser's cached Basic Auth credentials are
  forwarded automatically on every request — there's exactly one login prompt, even
  though nginx and webdav each independently validate the same credentials.
- **One credential source**: you only ever edit `/config/webdav-config.yml` (passwords
  plain text for easy setup, or `{bcrypt}`-hashed for better security; always run this
  behind HTTPS). An init
  script regenerates nginx's htpasswd file from that same YAML on every container
  start, so there's nothing to keep in sync by hand.
- **linuxserver.io conventions**: built on `ghcr.io/linuxserver/baseimage-alpine`
  (s6-overlay init), so `PUID`/`PGID` control what host user/group owns everything
  under `/config`.

## Quick start

A prebuilt image is published to GHCR on every push to `master` (`linux/amd64` only)
and on every release tag (both `linux/amd64` and `linux/arm64`).
Paste this into a `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  cloudytic80:
    image: ghcr.io/benmclean/cloudytic80:latest
    container_name: cloudytic80
    restart: unless-stopped
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      # "normal" logs only failed web requests; "verbose" logs all of them.
      - LOG_LEVEL=normal
    ports:
      # "host:container" - only change the host side (left of the colon)
      # Leave ":80" (right of the colon) exactly as shown.
      - "8080:80"
    volumes:
      # "host:container" - only change the host side (left of the colon)
      # Leave ":/config" (right of the colon) exactly as shown.
      - ./config:/config
    # Docker keeps container logs forever by default. This caps them at
    # about 30 MB (3 files of 10 MB), oldest dropped first.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Logs go to the container's output (`docker compose logs -f`), never to files.
The `logging:` block above caps them at about 30 MB. If you use `docker run`
instead, add `--log-opt max-size=10m --log-opt max-file=3`. Only failed web
requests are logged unless you set `LOG_LEVEL=verbose`.

**Login guessing is throttled.** Failed logins are limited to 10 a minute per
client address (then HTTP 429). A correct login still works while an address is
throttled. Behind a reverse proxy all users share the proxy's address unless you
set up nginx's `real_ip` module, so the limit is then shared between them. The
container also has a Docker health check that confirms both nginx and webdav are
answering.

**tic80.com traffic doesn't go through your server.** TIC-80's online features
(SURF's cart browser, web export, the version check) are requested straight from
each player's browser to TIC-80's own site. Which site is decided by the TIC-80
build in the image (a dev snapshot uses dev.tic80.com, a release uses tic80.com)
and is read from the build automatically, so there is nothing to configure. Your
server only handles the page and the `/dav/` storage. TIC-80 itself has no way to
upload a cart to the community site, so saving while inside that folder just fails
with "cart saving error".

That's it — no clone, no build. On first start, a default `config/webdav-config.yml`
is seeded automatically with no users configured. With no users, nginx and webdav both
deny every request — the site is fully locked out (safe, but unusable) until you
**add at least one user**, see [Managing users](#managing-users) below.

Open `http://localhost:8080/` — once you've added a user, you'll be prompted for
credentials immediately, before TIC-80 loads. Log in, and `save`/`load`/`files` in the
TIC-80 console now read and write `/config/data/<username>/` on the host.

This container does not terminate TLS. Basic Auth sends credentials on every request,
so once you've added users, put this behind a TLS-terminating reverse proxy (nginx,
Caddy, Traefik, etc.) for anything beyond local testing.

To pin a specific release instead of always floating on `latest`, use a tag like
`ghcr.io/benmclean/cloudytic80:v2026-09-24` — see this repo's
[Packages](https://github.com/BenMcLean/CloudyTIC80/pkgs/container/cloudytic80) page
for the full list of published tags.

## Building from source

Only needed if you want to modify the image yourself rather than pull the published
one:

```bash
docker build -t cloudytic80 .

mkdir -p ./config
docker run -d \
  --name cloudytic80 \
  -e PUID=1000 \
  -e PGID=1000 \
  -p 8080:80 \
  -v "$(pwd)/config:/config" \
  --log-opt max-size=10m --log-opt max-file=3 \
  cloudytic80
```

Same first-run behavior as above: no users are seeded, so you must
[add at least one](#managing-users) before the site is usable.

## Setting up in Portainer

No CLI needed. A `docker-compose.yml` is included at the repo root — Portainer's
**Stacks** feature consumes it directly.

1. Push this repo to a Git host Portainer can reach (GitHub, GitLab, a self-hosted
   Gitea, etc.) — or use Portainer's own Git server support if you have it configured.
2. In Portainer: **Stacks → Add stack**.
3. Choose **Repository** as the build method:
   - **Repository URL**: this repo's URL.
   - **Compose path**: `docker-compose.yml` (the default, already correct).
   - By default the compose file's `image:` points at the prebuilt
     `ghcr.io/benmclean/cloudytic80:latest`, so Portainer just pulls it — no in-Portainer
     build, fast to deploy. If you'd rather build from source (e.g. you're modifying the
     `Dockerfile`), change `image:` to `build: .` in the stack's compose text first; the
     first deploy will then take a while, since it's compiling TIC-80 via Emscripten.
4. Portainer's stack editor only exposes an **environment variables** form, not a
   volumes UI — so, like a typical LSIO-style stack, the bind-mount source, host port,
   and PUID/PGID/TZ are all parameterized in `docker-compose.yml` via `${VAR:-default}`
   substitution, settable entirely from that env-var form without touching the compose
   text:

   | Variable | Default | Controls |
   |---|---|---|
   | `PUID` | `1000` | passed through to the container |
   | `PGID` | `1000` | passed through to the container |
   | `TZ` | `Etc/UTC` | passed through to the container |
   | `HTTP_PORT` | `8080` | host port mapped to the container's `80` |
   | `CONFIG_DIR` | `./config` (relative to wherever Portainer checks the stack out) | host path bind-mounted to `/config` — set this to an absolute path (e.g. `/opt/cloudytic80/config`) if you don't want it relative to Portainer's internal stack directory |

   Leave any of these unset in Portainer's env-var form to keep the default.
5. Click **Deploy the stack**. Once it's up, go to the container's **Volumes** or use
   Portainer's built-in file browser/console to confirm `/config/webdav-config.yml` was
   seeded, then edit it there (or `docker cp` it out, edit, and copy back) to add at
   least one user — with none configured, nobody (including you) can log in.
6. To update: **Pull and redeploy** / **Update the stack** — Portainer pulls the newer
   `latest` image (or re-clones and rebuilds, if you switched to `build: .`).

## Managing users

Edit `config/webdav-config.yml` (created on first run from
`root/defaults/webdav-config.yml`) directly on the host, then restart the container.
It ships with no users configured — meaning nobody can log in at all — and a
commented-out template showing the shape of an entry:

```yaml
users:
  - username: alice
    password: changeme
    directory: /config/data/alice
    permissions: CRUD
  - username: bob
    password: changeme
    directory: /config/data/bob
    permissions: CRUD
```

- Add a user: uncomment the `users:` key and the template entry below it, then set a
  unique `username`, a `password`, and a `directory` under `/config/data/<username>`.
- Add another user: add another `- username: ...` entry under the same `users:` key
  (it's a YAML list) — don't repeat the `users:` key itself.
- Remove a user: delete their entry (their files under `/config/data/<username>` are
  left in place — remove that folder yourself if you want it gone too).
- Passwords can be **plain text** (the default — fast setup and testing, nothing to
  manage) or **bcrypt-hashed** (better security). Either way, keep this file's
  permissions private and always run behind HTTPS. To hash one, generate a bcrypt hash
  and paste it in quoted, with a `{bcrypt}` prefix:

  ```bash
  docker run --rm httpd:2-alpine htpasswd -nbBC 10 "" 'mypassword' | cut -d: -f2
  ```

  ```yaml
  password: "{bcrypt}$2y$10$...."
  ```

  The quotes are required (a bare `{` starts a YAML map). Plain and hashed users can be
  mixed in the same file; no other configuration is involved.
- Restart the container after any edit — an init script regenerates both webdav's own
  auth and nginx's htpasswd from this one file on every start.

## Environment variables

Inherited from the `linuxserver/baseimage-alpine` base image:

| Variable | Default | Purpose |
|---|---|---|
| `PUID` | `911` | UID that files under `/config` (and the nginx/webdav processes) run as. Set to match your host user so bind-mounted files are owned by you, not root. |
| `PGID` | `911` | GID, same idea as `PUID`. |
| `UMASK` | `022` | Default file-creation mask for files written inside the container. |
| `TZ` | (unset) | Container timezone, e.g. `America/New_York` — affects log timestamps only. |

CloudyTIC80 itself does not read any other environment variables — all app-level
configuration (users, passwords, per-user folders) lives in
`/config/webdav-config.yml`, not env vars, per the "static config file" design choice.

## Volumes

| Path | Purpose |
|---|---|
| `/config` | Everything persistent: `webdav-config.yml` (hand-edited user list), the regenerated `htpasswd`, and `data/<username>/` per-user cart storage. Mount this to a host directory or named volume — without it, all carts and users reset on container recreation. |

## Ports

| Port | Purpose |
|---|---|
| `80` | HTTP. The only exposed port — webdav listens on `127.0.0.1:6065` internally and is never reachable directly, only through nginx's `/dav/` proxy. |

## Build arguments (pinned versions)

| Build arg | What it pins |
|---|---|
| `TIC80_VERSION` | The TIC-80 revision to build. |
| `EMSDK_VERSION` | The Emscripten SDK version used to compile TIC-80 to WASM. |
| `WEBDAV_IMAGE` | The WebDAV server image its binary is extracted from. |
| `BASEIMAGE_ALPINE_TAG` | The linuxserver.io Alpine base image tag. |

Any of these can be overridden at build time, e.g.:

```bash
docker build --build-arg TIC80_VERSION=<some-other-revision> -t cloudytic80 .
```

## Repo layout

```
CloudyTIC80/
├── Dockerfile                # multi-stage: tic80-builder → webdav-extract → final
├── web/
│   └── webdav-shim.js        # FS.mount/FS.syncfs interception + WebDAV sync
└── root/                     # copied to image root
    ├── defaults/webdav-config.yml   # seeded to /config on first run
    └── etc/
        ├── nginx/                   # whole-site Basic Auth + /dav/ proxy config
        └── s6-overlay/
            ├── s6-rc.d/              # service/init definitions (see below)
            └── scripts/              # actual bash logic the oneshot "up" files chain into
```

Note on `s6-overlay/s6-rc.d/*/up` vs `scripts/`: s6-rc oneshot `up` files must be
execline, not bash — each `up` file here is a one-line execline shim
(`with-contenv /etc/s6-overlay/scripts/<name>`) that chains into the real bash script
under `scripts/`, which is invoked as its own process and so gets normal shebang
handling.

# Other Projects
- [CloudyDoom](https://github.com/BenMcLean/CloudyDoom): Multiplayer Doom, playable straight in the browser, pointed at your own dedicated server.
- [CloudyQuake](https://github.com/BenMcLean/CloudyQuake): Multiplayer Quake, playable straight in the browser, pointed at your own dedicated server.

## Tests

`tests/` holds real-browser end-to-end tests (see `tests/README.md`): among other things, that a
cart saved in TIC-80's console really lands on the server, only for its owner. CI builds the
image once, runs them against it, and publishes only if they pass.
