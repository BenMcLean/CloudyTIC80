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
                 │  - Basic Auth (webdav-config.yml, plaintext)     │
                 │  - per-user directory scope /config/data/<u>     │
                 └────────────────────────────────────────────────┘
```

- **The whole site is gated behind Basic Auth**, except `/favicon.ico` — deliberately,
  so nobody can start a project unauthenticated and only discover later that it was
  never being saved.
- **`web/webdav-shim.js`** is loaded before TIC-80's own compiled code runs. It wraps
  `Module.FS.mount` (to learn TIC-80's cart-storage mount path) and `Module.FS.syncfs`
  (TIC-80's own persistence trigger — called once at startup to populate, and again
  after every save/delete). On populate, it `PROPFIND`/`GET`s the user's existing carts
  from `/dav/` into the virtual filesystem. On every subsequent sync, it diffs the
  filesystem and `PUT`/`MKCOL`/`DELETE`s whatever changed. Local IDBFS persistence is
  left running too (harmless per-browser cache); the WebDAV server is the durable,
  cross-device source of truth.
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
- **One credential source**: you only ever edit `/config/webdav-config.yml` (plaintext
  passwords — a deliberate simplification; always run this behind HTTPS). An init
  script regenerates nginx's htpasswd file from that same YAML on every container
  start, so there's nothing to keep in sync by hand.
- **linuxserver.io conventions**: built on `ghcr.io/linuxserver/baseimage-alpine`
  (s6-overlay init), so `PUID`/`PGID` control what host user/group owns everything
  under `/config`.

## Quick start

```bash
docker build -t cloudytic80 .

mkdir -p ./config
docker run -d \
  --name cloudytic80 \
  -e PUID=1000 \
  -e PGID=1000 \
  -p 8080:80 \
  -v "$(pwd)/config:/config" \
  cloudytic80
```

On first start, a default `config/webdav-config.yml` is seeded automatically with no
users configured. With no users, nginx and webdav both deny every request — the site
is fully locked out (safe, but unusable) until you **add at least one user** — see
below.

Open `http://localhost:8080/` — once you've added a user, you'll be prompted for
credentials immediately, before TIC-80 loads. Log in, and `save`/`load`/`files` in the
TIC-80 console now read and write `/config/data/<username>/` on the host.

This container does not terminate TLS. Basic Auth sends credentials on every request,
so once you've added users, put this behind a TLS-terminating reverse proxy (nginx,
Caddy, Traefik, etc.) for anything beyond local testing.

## Setting up in Portainer

No CLI needed. A `docker-compose.yml` is included at the repo root — Portainer's
**Stacks** feature consumes it directly.

1. Push this repo to a Git host Portainer can reach (GitHub, GitLab, a self-hosted
   Gitea, etc.) — or use Portainer's own Git server support if you have it configured.
2. In Portainer: **Stacks → Add stack**.
3. Choose **Repository** as the build method:
   - **Repository URL**: this repo's URL.
   - **Compose path**: `docker-compose.yml` (the default, already correct).
   - Portainer will `git clone` the repo and build the image itself from the
     `Dockerfile` in the same repo — the first deploy takes a while, since it's
     compiling TIC-80 from source via Emscripten.
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
6. To rebuild after pulling a newer commit (e.g. after bumping `TIC80_VERSION` in the
   `Dockerfile`), use the stack's **Pull and redeploy** / **Update the stack** action —
   Portainer re-clones and rebuilds automatically.

If you'd rather not build via Portainer at all, build and push the image to a registry
yourself (`docker build -t <registry>/cloudytic80:<tag> . && docker push ...`), then
create the stack with the **Web editor** method instead, pointing `image:` at that
registry tag rather than using `build: .` — this skips the in-Portainer build entirely
and just pulls a prebuilt image, which is faster to deploy/update on subsequent
machines.

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
- Passwords are stored in **plain text** by design (no hashing step to manage) — keep
  this file's permissions private and always run behind HTTPS.
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

All upstream components are pinned explicitly; bump these deliberately when you want
a newer version, rather than tracking a floating tag:

| Build arg | Default | What it pins |
|---|---|---|
| `TIC80_VERSION` | `v1.2.0` | The TIC-80 git tag to build (Pro edition, unconditionally — not a build-time choice). |
| `EMSDK_VERSION` | `6.0.10` | The Emscripten SDK version used to compile TIC-80 to WASM. |
| `WEBDAV_IMAGE` | `hacdias/webdav:v5.16.0` | The WebDAV server image its binary is extracted from. |
| `BASEIMAGE_ALPINE_TAG` | `3.21-6689918e-ls38` | The linuxserver.io Alpine base image tag. |

Override at build time, e.g.:

```bash
docker build --build-arg TIC80_VERSION=v1.3.0 -t cloudytic80 .
```

## Repo layout

```
CloudyTIC80/
├── Dockerfile                # multi-stage: tic80-builder → webdav-extract → final
├── web/
│   ├── index.html            # our own shell (not TIC-80's own build/html/index.html)
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
