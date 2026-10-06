// Makes the server the only source of truth for TIC-80's cart folder, without touching
// TIC-80 itself. TIC-80's compiled code keeps its carts in Emscripten's in-memory
// filesystem (mounted as IDBFS); this shim hooks that filesystem's calls (Module.FS) before
// TIC-80's main() runs and turns every operation on the cart folder into a synchronous
// WebDAV request to the user's own folder on the server:
//
//   open for reading   GET  (the file is fetched fresh, every time)
//   stat, readdir      PROPFIND (every time; local entries the server doesn't have are removed)
//   open for writing   probe the server first, PUT the content when the file is closed
//   unlink / rmdir     DELETE     mkdir  MKCOL     rename  MOVE
//
// The in-memory filesystem is therefore only a scratch mirror that is refreshed from the
// server on every operation. Nothing is ever answered from it without asking the server,
// and nothing falls back to it when the server cannot be reached: the operation fails
// instead, so TIC-80 reports it (as far as TIC-80 reports anything) and the page shows a
// red banner. Operations are synchronous (sync XHR) because the engine's filesystem calls
// cannot wait.
//
// TIC-80's own code (src/studio/fs.c) only ever looks at whether `fopen` worked when saving,
// and ignores the result of `fwrite`/`fclose`. So an upload that fails is made to fail the
// `fopen` where possible (the server is probed first), and otherwise rolls the local file
// back and shows the banner, so nothing claims to be saved that is not.
//
// The reserved ".local" tree (TIC-80's own settings and its cache of tic80.com carts) is not
// the user's work and stays purely local, as before. TIC-80's options file lives in it; the
// deployment's option defaults are written there at startup (see OPTION_DEFAULTS).
var CloudyTIC80Shim = (function () {
  var DAV_PREFIX = '/dav';
  var RESERVED = '.local';

  // Emscripten errno values.
  var EACCES = 2, EEXIST = 20, EIO = 29, EISDIR = 31, ENOENT = 44, ENOSYS = 52,
      ENOTDIR = 54, ENOTEMPTY = 55;

  // TIC-80's own options (src/studio/config.c) that this deployment sets. They are written
  // into TIC-80's options file in the browser before TIC-80 starts and reads it. DEFAULTS only
  // apply while the browser has no saved options yet, so anything a user changes later
  // sticks; FORCED are applied on every start, so a changed value lasts one session.
  // tabMode: 0 = auto, 1 = tabs, 2 = spaces.
  // These are what applies when the server owner has no /config/tic80-options.json; that
  // file (served at OPTIONS_URL) has the same two sections and replaces them key by key.
  var OPTION_DEFAULTS = { crt: false };
  var OPTION_FORCED = { tabMode: 1, tabSize: 4 };

  var OPTIONS_URL = '/tic80-options.json';

  var mountDir = null;
  var ready = false;       // the startup load has finished; hooks are live
  var bypass = 0;          // >0 while the shim itself is changing the mirror
  var known = Object.create(null); // mirror path -> last server "modified" stamp it was fetched at
  var openWrites = Object.create(null); // mirror paths currently open for writing
  var failures = { read: null, write: null, config: null };
  var banner = null;

  // ---- banner -------------------------------------------------------------------

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'font:13px/1.4 monospace;color:#fff;background:#8b0d1e;' +
      'padding:8px 12px;text-align:center;box-shadow:0 -1px 6px rgba(0,0,0,.5);' +
      'display:none;';
    document.body.appendChild(banner);
    return banner;
  }

  // Failures stay on screen until an operation of the same kind succeeds, so a failed save
  // is not wiped away by the next (successful) listing.
  function renderBanner() {
    var message = failures.write || failures.read || failures.config;
    var el = ensureBanner();
    el.textContent = message || '';
    el.style.display = message ? 'block' : 'none';
  }

  function setFailure(kind, message, err) {
    failures[kind] = message;
    console.error('CloudyTIC80: ' + message, err);
    renderBanner();
  }

  function clearFailure(kind) {
    if (failures[kind]) {
      failures[kind] = null;
      renderBanner();
    }
  }

  // ---- paths --------------------------------------------------------------------

  function davUrl(relPath) {
    return DAV_PREFIX + relPath;
  }

  function normalizePath(path) {
    return path.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  }

  function toRelPath(fullPath) {
    if (fullPath === mountDir) return '/';
    var rel = fullPath.slice(mountDir.length);
    if (rel[0] !== '/') rel = '/' + rel;
    return rel;
  }

  function parentOf(path) {
    return path.replace(/\/[^\/]*$/, '') || '/';
  }

  function baseName(path) {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  // TIC-80 writes its own internal bookkeeping (including cached copies of carts
  // downloaded from tic80.com/SURF) under ".local/" relative to the mount (TIC_LOCAL in
  // src/studio/studio.h). That is disposable and never the user's own work.
  function isReservedLocalDir(relPath) {
    return /^\/\.local(\/|$)/.test(relPath);
  }

  // The normalized mirror path when `path` is something the server owns and the hooks are
  // live; null for everything else (other folders, the reserved tree, the shim's own work).
  function cloudPath(path) {
    if (!ready || bypass > 0 || mountDir === null || typeof path !== 'string') return null;
    var p = normalizePath(path);
    if (p !== mountDir && p.indexOf(mountDir + '/') !== 0) return null;
    return isReservedLocalDir(toRelPath(p)) ? null : p;
  }

  // ---- synchronous WebDAV -------------------------------------------------------

  // Throws an Error carrying `status` (0 for a network failure) on anything but 2xx.
  function dav(method, relPath, opts) {
    opts = opts || {};
    var xhr = new XMLHttpRequest();
    xhr.open(method, davUrl(relPath), false);
    if (method === 'PROPFIND') xhr.setRequestHeader('Depth', opts.depth || '1');
    if (opts.destination) {
      xhr.setRequestHeader('Destination', location.origin + encodeURI(davUrl(opts.destination)));
      xhr.setRequestHeader('Overwrite', 'T');
    }
    // Sync XHR on the main thread cannot use responseType, so read bytes as text.
    if (opts.binary) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try {
      xhr.send(opts.body || null);
    } catch (e) {
      var netErr = new Error(method + ' ' + relPath + ' failed (network error)');
      netErr.status = 0;
      throw netErr;
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      var err = new Error(method + ' ' + relPath + ' failed (HTTP ' + xhr.status + ')');
      err.status = xhr.status;
      throw err;
    }
    return xhr;
  }

  function responseBytes(xhr) {
    var text = xhr.responseText;
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  function parseEntry(respEl) {
    var hrefEl = respEl.getElementsByTagNameNS('DAV:', 'href')[0];
    if (!hrefEl) return null;
    var pathname;
    try { pathname = new URL(hrefEl.textContent, location.origin).pathname; }
    catch (e) { pathname = hrefEl.textContent; }
    pathname = decodeURIComponent(pathname.replace(/\/+$/, ''));
    var modEl = respEl.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
    var lenEl = respEl.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
    return {
      pathname: pathname,
      name: pathname.split('/').pop(),
      dir: respEl.getElementsByTagNameNS('DAV:', 'collection').length > 0,
      modified: modEl ? modEl.textContent : '',
      size: lenEl ? Number(lenEl.textContent) : -1
    };
  }

  function propfind(relPath, depth) {
    var xhr = dav('PROPFIND', relPath, { depth: depth });
    if (!xhr.responseText) return [];
    var doc = new DOMParser().parseFromString(xhr.responseText, 'application/xml');
    var responses = doc.getElementsByTagNameNS('DAV:', 'response');
    var out = [];
    for (var i = 0; i < responses.length; i++) {
      var entry = parseEntry(responses[i]);
      if (entry) out.push(entry);
    }
    return out;
  }

  // {dir, modified, size} for what the server has at relPath, or null if nothing.
  function statServer(relPath) {
    try {
      var entries = propfind(relPath, '0');
      return entries.length ? entries[0] : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Children of a server folder by name; null if the folder does not exist.
  function listServer(relPath) {
    var selfPath = relPath.replace(/\/+$/, '');
    var entries;
    try {
      entries = propfind(relPath, '1');
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    var out = Object.create(null);
    entries.forEach(function (entry) {
      // webdav's hrefs are relative to ITS namespace (nginx strips the /dav/ prefix before
      // proxying), so the folder's own entry is the one equal to relPath itself.
      if (entry.pathname === selfPath || !entry.name) return;
      out[entry.name] = entry;
    });
    return out;
  }

  // ---- the mirror (always with hooks bypassed) ----------------------------------

  function quietly(fn) {
    bypass++;
    try { return fn(); } finally { bypass--; }
  }

  function mirrorExists(FS, path) {
    return quietly(function () {
      try { FS.lstat(path); return true; } catch (e) { return false; }
    });
  }

  function mirrorIsDir(FS, path) {
    return quietly(function () {
      try { return FS.isDir(FS.lstat(path).mode); } catch (e) { return false; }
    });
  }

  function removeMirror(FS, path) {
    if (!mirrorExists(FS, path)) return;
    if (mirrorIsDir(FS, path)) {
      FS.readdir(path).forEach(function (name) {
        if (name !== '.' && name !== '..') removeMirror(FS, path + '/' + name);
      });
      FS.rmdir(path);
    } else {
      FS.unlink(path);
    }
    delete known[path];
  }

  function ensureMirrorDir(FS, path) {
    if (mirrorExists(FS, path) && !mirrorIsDir(FS, path)) removeMirror(FS, path);
    if (!mirrorExists(FS, path)) FS.mkdirTree(path);
    known[path] = true;
  }

  function writeMirror(FS, path, bytes, modified) {
    ensureMirrorDir(FS, parentOf(path));
    if (mirrorIsDir(FS, path)) removeMirror(FS, path);
    FS.writeFile(path, bytes);
    known[path] = modified;
  }

  // Fetches a file's current content from the server into the mirror.
  function fetchFile(FS, path, rel, modified) {
    var bytes = responseBytes(dav('GET', rel, { binary: true }));
    quietly(function () { writeMirror(FS, path, bytes, modified); });
    return bytes;
  }

  // Makes the mirror's folder match the server's listing of it: new and changed files are
  // fetched, anything the server does not have is removed. Local entries are never trusted.
  function reconcileDir(FS, dirPath) {
    var rel = toRelPath(dirPath);
    var server = listServer(rel);
    if (server === null) {
      quietly(function () { removeMirror(FS, dirPath); });
      return false;
    }
    quietly(function () {
      ensureMirrorDir(FS, dirPath);
      FS.readdir(dirPath).forEach(function (name) {
        if (name === '.' || name === '..') return;
        if (dirPath === mountDir && name === RESERVED) return;
        var full = dirPath + '/' + name;
        if (!server[name] && !openWrites[full]) removeMirror(FS, full);
      });
    });
    Object.keys(server).forEach(function (name) {
      var full = dirPath + '/' + name;
      var childRel = (rel === '/' ? '' : rel) + '/' + name;
      if (isReservedLocalDir(childRel) || openWrites[full]) return;
      var entry = server[name];
      if (entry.dir) {
        quietly(function () { ensureMirrorDir(FS, full); });
      } else if (known[full] !== entry.modified || !mirrorExists(FS, full) || mirrorIsDir(FS, full)) {
        fetchFile(FS, full, childRel, entry.modified);
      }
    });
    return true;
  }

  // Brings the mirror's entry for one path in line with the server; returns the server's
  // answer (null when the server has nothing there, after removing the mirror's copy).
  function refreshEntry(FS, path, alwaysFetch) {
    var rel = toRelPath(path);
    var entry = statServer(rel);
    if (!entry) {
      quietly(function () { removeMirror(FS, path); });
      return null;
    }
    if (entry.dir) {
      quietly(function () { ensureMirrorDir(FS, path); });
    } else if (alwaysFetch || known[path] !== entry.modified || !mirrorExists(FS, path) || mirrorIsDir(FS, path)) {
      fetchFile(FS, path, rel, entry.modified);
    }
    return entry;
  }

  // ---- errors -------------------------------------------------------------------

  function errnoFor(err) {
    if (err.status === 404) return ENOENT;
    if (err.status === 401 || err.status === 403) return EACCES;
    return EIO;
  }

  // An infrastructure failure (server unreachable, refused, login lost, ...): shown on
  // the page and thrown into TIC-80 as an I/O error. `kind` is 'read' or 'write'.
  function fail(FS, kind, what, err) {
    var msg = (kind === 'write' ? 'NOT SAVED / NOT CHANGED: ' : 'COULD NOT READ FROM THE SERVER: ') +
      what + ' (' + err.message + ').';
    if (kind === 'write') msg += ' Nothing was changed on the server.';
    setFailure(kind, msg, err);
    throw new FS.ErrnoError(err.status === 401 || err.status === 403 ? EACCES : EIO);
  }

  // Runs a server operation for a hook: ordinary "not there" answers become the matching
  // errno silently (they are normal results, e.g. `load` of a cart that does not exist);
  // everything else is loud.
  function guarded(FS, kind, what, fn) {
    var result;
    try {
      result = fn();
    } catch (e) {
      if (e && e.errno !== undefined) throw e; // already an ErrnoError
      if (e && e.status === 404) throw new FS.ErrnoError(ENOENT);
      fail(FS, kind, what, e);
    }
    clearFailure(kind);
    return result;
  }

  // ---- the hooks ----------------------------------------------------------------

  function hookFilesystem(FS) {
    var real = {};
    ['open', 'close', 'stat', 'lstat', 'readdir', 'unlink', 'rmdir', 'mkdir', 'rename',
     'truncate', 'symlink', 'link', 'mknod'].forEach(function (name) { real[name] = FS[name]; });

    FS.readdir = function (path) {
      var p = cloudPath(path);
      if (p) {
        var found = guarded(FS, 'read', 'listing ' + toRelPath(p), function () { return reconcileDir(FS, p); });
        if (!found) throw new FS.ErrnoError(ENOENT);
      }
      return real.readdir.apply(FS, arguments);
    };

    ['stat', 'lstat'].forEach(function (name) {
      FS[name] = function (path) {
        var p = cloudPath(path);
        if (p && p !== mountDir) {
          var entry = guarded(FS, 'read', name + ' ' + toRelPath(p), function () { return refreshEntry(FS, p, false); });
          if (!entry) throw new FS.ErrnoError(ENOENT);
        }
        return real[name].apply(FS, arguments);
      };
    });

    FS.open = function (path, flags) {
      var p = cloudPath(path);
      if (!p || p === mountDir) return real.open.apply(FS, arguments);
      var rel = toRelPath(p);

      var writing = typeof flags === 'string'
        ? (flags.charAt(0) !== 'r' || flags.indexOf('+') !== -1)
        : typeof flags === 'number' && (flags & 3) !== 0;

      if (!writing) {
        var entry = guarded(FS, 'read', 'reading ' + rel, function () { return refreshEntry(FS, p, true); });
        if (!entry) throw new FS.ErrnoError(ENOENT);
        return real.open.apply(FS, arguments);
      }

      // Writing: the folder it goes into must exist on the server, and the server must be
      // answering and accepting us right now. This is the only point at which TIC-80's save
      // can be made to report a failure.
      var before = null;
      guarded(FS, 'write', 'saving ' + rel, function () {
        var parent = statServer(parentOf(rel));
        if (!parent || !parent.dir) { var nf = new Error('folder missing'); nf.status = 404; throw nf; }
        var existing = refreshEntry(FS, p, true);
        if (existing && existing.dir) { var isDir = new FS.ErrnoError(EISDIR); throw isDir; }
        if (existing) before = quietly(function () { return FS.readFile(p); });
        quietly(function () { ensureMirrorDir(FS, parentOf(p)); });
      });
      var stream = real.open.apply(FS, arguments);
      openWrites[p] = (openWrites[p] || 0) + 1;
      stream.cloudyWrite = { path: p, rel: rel, before: before, existed: before !== null };
      return stream;
    };

    FS.close = function (stream) {
      var w = stream && stream.cloudyWrite;
      var result = real.close.apply(FS, arguments);
      if (!w) return result;
      if (--openWrites[w.path] <= 0) delete openWrites[w.path];
      var data = quietly(function () { return FS.readFile(w.path); });
      try {
        dav('PUT', w.rel, { body: data });
        var stored = statServer(w.rel);
        if (!stored || stored.dir || (stored.size !== -1 && stored.size !== data.length)) {
          throw new Error('the server does not hold the file it was just sent');
        }
        known[w.path] = stored.modified;
        clearFailure('write');
      } catch (e) {
        quietly(function () {
          try {
            if (w.existed) writeMirror(FS, w.path, w.before, known[w.path]); else removeMirror(FS, w.path);
          } catch (e2) {
            console.error('CloudyTIC80: could not roll back ' + w.rel, e2);
          }
        });
        setFailure('write', 'NOT SAVED: ' + w.rel + ' did not reach the server (' + e.message +
          '). It was not saved; try again once the connection is back.', e);
        throw new FS.ErrnoError(EIO);
      }
      return result;
    };

    FS.unlink = function (path) {
      var p = cloudPath(path);
      if (p && p !== mountDir) {
        var rel = toRelPath(p);
        guarded(FS, 'write', 'deleting ' + rel, function () {
          var entry = statServer(rel);
          if (!entry) throw new FS.ErrnoError(ENOENT);
          if (entry.dir) throw new FS.ErrnoError(EISDIR);
          dav('DELETE', rel);
        });
        quietly(function () { removeMirror(FS, p); });
        return;
      }
      return real.unlink.apply(FS, arguments);
    };

    FS.rmdir = function (path) {
      var p = cloudPath(path);
      if (p && p !== mountDir) {
        var rel = toRelPath(p);
        guarded(FS, 'write', 'deleting folder ' + rel, function () {
          var entry = statServer(rel);
          if (!entry) throw new FS.ErrnoError(ENOENT);
          if (!entry.dir) throw new FS.ErrnoError(ENOTDIR);
          // WebDAV's DELETE removes a folder with everything in it; rmdir must not.
          if (Object.keys(listServer(rel) || {}).length) throw new FS.ErrnoError(ENOTEMPTY);
          dav('DELETE', rel);
        });
        quietly(function () { removeMirror(FS, p); });
        return;
      }
      return real.rmdir.apply(FS, arguments);
    };

    FS.mkdir = function (path) {
      var p = cloudPath(path);
      if (p && p !== mountDir) {
        var rel = toRelPath(p);
        guarded(FS, 'write', 'creating folder ' + rel, function () {
          try {
            dav('MKCOL', rel);
          } catch (e) {
            if (e.status === 405) throw new FS.ErrnoError(EEXIST);
            if (e.status === 409) throw new FS.ErrnoError(ENOENT);
            throw e;
          }
        });
        quietly(function () { ensureMirrorDir(FS, p); });
        return;
      }
      return real.mkdir.apply(FS, arguments);
    };

    FS.rename = function (oldPath, newPath) {
      var from = cloudPath(oldPath), to = cloudPath(newPath);
      if (from || to) {
        if (!from || !to) {
          fail(FS, 'write', 'moving between the server folder and elsewhere',
            new Error('not supported'));
        }
        guarded(FS, 'write', 'renaming ' + toRelPath(from), function () {
          if (!statServer(toRelPath(from))) throw new FS.ErrnoError(ENOENT);
          dav('MOVE', toRelPath(from), { destination: toRelPath(to) });
        });
        guarded(FS, 'read', 'reading back ' + toRelPath(to), function () {
          quietly(function () { removeMirror(FS, from); });
          refreshEntry(FS, to, true);
        });
        return;
      }
      return real.rename.apply(FS, arguments);
    };

    // Operations that would change the mirror without the server ever hearing of it. There
    // is no way to do them on the server, so they fail instead of silently diverging.
    ['truncate', 'symlink', 'link', 'mknod'].forEach(function (name) {
      FS[name] = function (a, b) {
        // Creating a regular file is how FS.open makes a new file; its content reaches the
        // server when it is closed, so only special files are refused here.
        if (name === 'mknod' && ((b & 0xF000) === 0x8000 || (b & 0xF000) === 0)) {
          return real.mknod.apply(FS, arguments);
        }
        var target = name === 'symlink' ? b : a;
        if (cloudPath(target) || (name === 'link' && cloudPath(b))) {
          fail(FS, 'write', name + ' on ' + (cloudPath(target) ? toRelPath(cloudPath(target)) : target),
            new Error('not supported by the server storage'));
        }
        return real[name].apply(FS, arguments);
      };
    });
  }

  // ---- startup ------------------------------------------------------------------

  // The mirror is rebuilt from the server every time, so whatever the browser's own
  // IndexedDB copy of the cart folder holds (this user's last session, or another user's on
  // a shared machine) is dropped. The reserved tree is TIC-80's own settings and is kept.
  function wipeMirror(FS) {
    quietly(function () {
      FS.readdir(mountDir).forEach(function (name) {
        if (name === '.' || name === '..' || name === RESERVED) return;
        try { removeMirror(FS, mountDir + '/' + name); } catch (e) { /* listed live anyway */ }
      });
    });
  }

  // The server owner's own option sections, from /config/tic80-options.json. Nothing there
  // (404) means the built-in values above. A file that exists but cannot be used is not
  // quietly ignored: the page says so, and the built-in values apply meanwhile.
  function loadOwnerOptions() {
    var owner = { defaults: {}, forced: {} };
    var xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', OPTIONS_URL, false);
      xhr.send(null);
    } catch (e) {
      setFailure('config', 'COULD NOT READ tic80-options.json (network error); using the built-in option defaults.', e);
      return owner;
    }
    if (xhr.status === 404) return owner;
    try {
      if (xhr.status < 200 || xhr.status >= 300) throw new Error('HTTP ' + xhr.status);
      var parsed = JSON.parse(xhr.responseText);
      var ok = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      ['defaults', 'forced'].forEach(function (section) {
        if (!ok || parsed[section] === undefined) return;
        if (parsed[section] === null || typeof parsed[section] !== 'object' || Array.isArray(parsed[section])) ok = false;
      });
      if (!ok) throw new Error('it must be an object with optional "defaults" and "forced" objects');
      owner.defaults = parsed.defaults || {};
      owner.forced = parsed.forced || {};
    } catch (e) {
      setFailure('config', 'tic80-options.json is not usable (' + e.message + '); using the built-in option defaults.', e);
      return { defaults: {}, forced: {} };
    }
    return owner;
  }

  function applyOptions(FS) {
    var optionsPath = window.CloudyTIC80Config && window.CloudyTIC80Config.optionsPath;
    if (!optionsPath) {
      console.error('CloudyTIC80: config.js did not say where TIC-80 keeps its options; defaults not applied');
      return;
    }
    var owner = loadOwnerOptions();
    var path = mountDir + '/' + optionsPath;
    var options = null;
    try { options = JSON.parse(FS.readFile(path, { encoding: 'utf8' })); } catch (e) { /* none yet */ }
    if (!options || typeof options !== 'object') {
      options = Object.assign({}, OPTION_DEFAULTS, owner.defaults);
    }
    Object.assign(options, OPTION_FORCED, owner.forced);
    FS.mkdirTree(parentOf(path));
    FS.writeFile(path, JSON.stringify(options));
  }

  // TIC-80's compiled network code (surf, web export, ...) requests these paths
  // relative to wherever the page is served from, which only works on tic80.com
  // itself. Redirect them there directly from the browser, so none of that traffic
  // passes through this server. tic80.com allows cross-origin requests. Which site
  // depends on the TIC-80 build (a dev snapshot uses dev.tic80.com, a release uses
  // tic80.com): the Dockerfile reads it from the build and writes it to config.js.
  var UPSTREAM = window.CloudyTIC80Config && window.CloudyTIC80Config.upstream;
  var UPSTREAM_PATHS = /^\/(json|cart\/|export\/|js\/)/;

  function upstreamUrl(url) {
    try {
      var u = new URL(String(url), location.href);
      if (u.origin === location.origin && UPSTREAM_PATHS.test(u.pathname)) {
        return UPSTREAM + u.pathname + u.search;
      }
    } catch (e) { /* not a URL we understand - leave it alone */ }
    return null;
  }

  function redirectUpstream() {
    if (!UPSTREAM) {
      console.error('CloudyTIC80: config.js did not set the TIC-80 site; SURF and web export will not work');
      return;
    }
    var realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var rewritten = upstreamUrl(url);
      if (rewritten) arguments[1] = rewritten;
      return realOpen.apply(this, arguments);
    };

    var realFetch = window.fetch;
    if (realFetch) {
      window.fetch = function (input, init) {
        var rewritten = upstreamUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (rewritten) {
          input = typeof input === 'string' || input instanceof URL ? rewritten : new Request(rewritten, input);
        }
        return realFetch.call(window, input, init);
      };
    }
  }

  // IDBFS (the browser-local persistence TIC-80 mounts) reads and writes the mirror through
  // the same FS calls the hooks watch. Those are its own bookkeeping, not TIC-80's file
  // operations, so they must not turn into server requests.
  function shieldIdbfs(type) {
    ['getLocalSet', 'loadLocalEntry', 'storeLocalEntry', 'removeLocalEntry'].forEach(function (name) {
      var original = type && type[name];
      if (typeof original !== 'function') {
        console.error('CloudyTIC80: IDBFS.' + name + ' not found; local persistence may hit the server');
        return;
      }
      type[name] = function () {
        bypass++;
        try { return original.apply(this, arguments); } finally { bypass--; }
      };
    });
  }

  function install(Module) {
    redirectUpstream();
    Module.preRun = Module.preRun || [];
    Module.preRun.push(function () {
      var FS = Module.FS;

      // Learn TIC-80's cart-storage mount path.
      var realMount = FS.mount;
      FS.mount = function (type, opts, mountpoint) {
        if (mountDir === null) {
          // TIC-80 mounts "/com.nesbox.tic/TIC-80/", with a trailing slash that no path
          // handed to the filesystem keeps; compare against the normalized form.
          mountDir = normalizePath(mountpoint);
          shieldIdbfs(type);
        }
        return realMount.call(FS, type, opts, mountpoint);
      };

      hookFilesystem(FS);

      // TIC-80 calls syncfs(true) once at startup and syncfs(false) after every change.
      // Our changes are written through as they happen, so the second kind only has to
      // keep IDBFS persisting the reserved settings tree; the first one finishes loading
      // the browser's local state, then discards the cart-folder part of it (see
      // wipeMirror) and checks, loudly, that the server is answering.
      var realSyncfs = FS.syncfs;
      FS.syncfs = function (populate, callback) {
        if (!populate) { realSyncfs.call(FS, populate, callback); return; }
        bypass++;
        realSyncfs.call(FS, true, function (err) {
          try {
            if (mountDir !== null) {
              wipeMirror(FS);
              applyOptions(FS);
              ready = true;
            }
          } finally { bypass--; }
          if (mountDir !== null) {
            try {
              if (!statServer('/')) throw new Error('your folder does not exist on the server');
              clearFailure('read');
            } catch (e) {
              setFailure('read', 'COULD NOT REACH YOUR FOLDER ON THE SERVER (' + e.message +
                '). Nothing can be loaded or saved until it is back; reload to retry.', e);
            }
          }
          callback(err);
        });
      };
    });
  }

  // mountDir is exposed for the end-to-end tests.
  return { install: install, mountDir: function () { return mountDir; } };
})();
