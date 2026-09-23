// Redirects TIC-80's Emscripten virtual filesystem (MEMFS/IDBFS, mounted by TIC-80's
// own compiled code) to per-user WebDAV storage on the server, without touching TIC-80
// itself. Hooks FS.mount (to learn TIC-80's cart-storage mount path) and FS.syncfs
// (TIC-80's own persistence trigger) before TIC-80's main() runs.
//
// TIC-80's own syncfs callbacks (src/system/sdl/main.c) discard the `err` argument
// entirely, so a failed save/load never reaches the user through TIC-80 itself. This
// shim therefore has to surface failures on its own: it never silently marks a failed
// write as synced (so it's retried on the next sync instead of being lost), and it
// shows a persistent on-page banner for as long as anything is unsynced.
var CloudyTIC80Shim = (function () {
  var DAV_PREFIX = '/dav';
  var mountDir = null;
  var knownFiles = Object.create(null);
  var everFullyLoaded = false;
  var banner = null;

  // Saving a cart under this name (any extension - e.g. "download.tic",
  // "download.wasmp", "download.lua") skips server storage entirely and
  // instead pushes the file straight to the browser's Save As dialog, so
  // players can pull a cart down to their own device. Matched against the
  // filename stem only, case-insensitively.
  var DOWNLOAD_TRIGGER = 'download';

  function davUrl(relPath) {
    return DAV_PREFIX + relPath;
  }

  function isDownloadTrigger(fsPath) {
    var base = fsPath.split('/').pop();
    var stem = base.replace(/\.[^./]+$/, '');
    return stem.toLowerCase() === DOWNLOAD_TRIGGER;
  }

  function triggerBrowserDownload(fsPath, data) {
    var name = fsPath.split('/').pop();
    var blob = new Blob([data], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showNotice('Downloaded ' + name + ' to your device.');
  }

  function showNotice(message) {
    var el = ensureBanner();
    el.textContent = message;
    el.style.background = '#0d6b2f';
    el.style.display = 'block';
    setTimeout(function () {
      el.style.background = '#8b0d1e';
      el.style.display = 'none';
    }, 4000);
  }

  function toRelPath(fullPath) {
    if (fullPath === mountDir) return '/';
    var rel = fullPath.slice(mountDir.length);
    if (rel[0] !== '/') rel = '/' + rel;
    return rel;
  }

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

  function showError(message) {
    var el = ensureBanner();
    el.textContent = message;
    el.style.display = 'block';
  }

  function hideError() {
    if (banner) banner.style.display = 'none';
  }

  function xhrRequest(method, relPath, body, responseType) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, davUrl(relPath), true);
      if (responseType) xhr.responseType = responseType;
      if (method === 'PROPFIND') xhr.setRequestHeader('Depth', '1');
      xhr.onloadend = function () {
        var ok = xhr.status >= 200 && xhr.status < 300;
        if (ok) {
          resolve(xhr);
        } else {
          reject(new Error(method + ' ' + relPath + ' failed (HTTP ' + xhr.status + ')'));
        }
      };
      xhr.onerror = function () {
        reject(new Error(method + ' ' + relPath + ' failed (network error)'));
      };
      xhr.send(body || null);
    });
  }

  function fetchDirRecursive(FS, fsDir, relDir) {
    return xhrRequest('PROPFIND', relDir).then(function (xhr) {
      if (!xhr.responseText) return;
      var doc = new DOMParser().parseFromString(xhr.responseText, 'application/xml');
      var responses = doc.getElementsByTagNameNS('DAV:', 'response');
      // webdav's own href values are relative to ITS namespace (nginx strips the
      // /dav/ prefix before proxying), so compare against relDir, not davUrl(relDir).
      var selfPath = relDir.replace(/\/+$/, '');
      var chain = Promise.resolve();
      for (var i = 0; i < responses.length; i++) {
        (function (respEl) {
          var hrefEl = respEl.getElementsByTagNameNS('DAV:', 'href')[0];
          if (!hrefEl) return;
          var pathname;
          try { pathname = new URL(hrefEl.textContent, location.origin).pathname; }
          catch (e) { pathname = hrefEl.textContent; }
          pathname = decodeURIComponent(pathname.replace(/\/+$/, ''));
          if (pathname === selfPath) return; // the directory's own PROPFIND entry
          var name = pathname.split('/').pop();
          if (!name) return;
          var isCollection = respEl.getElementsByTagNameNS('DAV:', 'collection').length > 0;
          var childRel = (relDir === '/' ? '' : relDir) + '/' + name;
          var childFs = fsDir + '/' + name;
          chain = chain.then(function () {
            if (isCollection) {
              try { FS.mkdir(childFs); } catch (e) { /* already exists */ }
              knownFiles[childFs] = { dir: true };
              return fetchDirRecursive(FS, childFs, childRel);
            }
            return fetchFile(FS, childFs, childRel);
          });
        })(responses[i]);
      }
      return chain;
    });
  }

  function fetchFile(FS, fsPath, relPath) {
    return xhrRequest('GET', relPath, null, 'arraybuffer').then(function (xhr) {
      FS.writeFile(fsPath, new Uint8Array(xhr.response));
      var st = FS.stat(fsPath);
      knownFiles[fsPath] = { size: st.size, mtime: st.mtime.getTime() };
    });
  }

  function populateFromServer(FS) {
    return fetchDirRecursive(FS, mountDir, '/').then(function () {
      everFullyLoaded = true;
    });
  }

  function collectEntries(FS, dir, out) {
    var names;
    try { names = FS.readdir(dir); } catch (e) { return; }
    names.forEach(function (name) {
      if (name === '.' || name === '..') return;
      var full = dir + '/' + name;
      var st;
      try { st = FS.stat(full); } catch (e) { return; }
      if (FS.isDir(st.mode)) {
        out.push({ path: full, dir: true });
        collectEntries(FS, full, out);
      } else {
        out.push({ path: full, dir: false, size: st.size, mtime: st.mtime.getTime() });
      }
    });
  }

  function pushChangesToServer(FS) {
    var entries = [];
    collectEntries(FS, mountDir, entries);
    var seen = Object.create(null);
    var chain = Promise.resolve();
    var failures = [];

    entries.forEach(function (entry) {
      seen[entry.path] = true;
      var known = knownFiles[entry.path];
      if (entry.dir) {
        if (!known) {
          chain = chain.then(function () {
            return xhrRequest('MKCOL', toRelPath(entry.path)).then(function () {
              knownFiles[entry.path] = { dir: true };
            }, function (err) {
              failures.push(err);
            });
          });
        }
        return;
      }
      if (isDownloadTrigger(entry.path)) {
        // Only fire when this save actually changed the file - otherwise a file
        // merely synced down from the server on a previous load (with matching
        // size/mtime already in knownFiles) would re-trigger a download popup on
        // every unrelated save/delete elsewhere in the tree. Leaving `known` and
        // the local file untouched here also means the server's own copy (if any
        // pre-dates this feature) is never pushed to, overwritten, or deleted.
        if (known && known.size === entry.size && known.mtime === entry.mtime) return;
        chain = chain.then(function () {
          var data;
          try {
            data = FS.readFile(entry.path);
          } catch (e) {
            failures.push(e);
            return;
          }
          triggerBrowserDownload(entry.path, data);
          try { FS.unlink(entry.path); } catch (e) { /* ignore */ }
          delete knownFiles[entry.path];
        });
        return;
      }

      if (!known || known.size !== entry.size || known.mtime !== entry.mtime) {
        chain = chain.then(function () {
          var data;
          try {
            data = FS.readFile(entry.path);
          } catch (e) {
            failures.push(e);
            return;
          }
          // Only mark this file as synced once the server has actually accepted it -
          // if the PUT fails, knownFiles is left untouched so the file still looks
          // "changed" and gets retried on the next syncfs call instead of the loss
          // going unnoticed.
          return xhrRequest('PUT', toRelPath(entry.path), data).then(function () {
            knownFiles[entry.path] = { size: entry.size, mtime: entry.mtime };
          }, function (err) {
            failures.push(err);
          });
        });
      }
    });

    // Only ever delete server-side files once we know we've seen the server's full,
    // real file list at least once - otherwise a failed/partial initial load could
    // look like "everything else was deleted locally" and wipe the user's cloud saves.
    if (everFullyLoaded) {
      Object.keys(knownFiles).forEach(function (path) {
        if (!seen[path]) {
          chain = chain.then(function () {
            return xhrRequest('DELETE', toRelPath(path)).then(function () {
              delete knownFiles[path];
            }, function (err) {
              failures.push(err);
            });
          });
        }
      });
    }

    return chain.then(function () {
      if (failures.length) {
        var err = new Error(
          'Failed to save ' + failures.length + ' item(s) to the server: ' +
          failures.map(function (e) { return e.message; }).join('; ')
        );
        err.failures = failures;
        throw err;
      }
    });
  }

  function joinPath(dir, name) {
    return (dir.replace(/\/+$/, '') + '/' + name).replace(/\/{2,}/g, '/');
  }

  // "tic80.com" is a virtual folder TIC-80's own console lets you `cd` into
  // (same mechanism whether you get there via `cd tic80.com` or the SURF UI) -
  // it's a proxy onto the real tic80.com site, not real storage under mountDir,
  // and nginx maps json/cart/export/js requests there directly (see the nginx
  // conf). If FS.cwd() ever reports being inside it (or a subfolder of it),
  // that's storage this shim must never write into.
  function isReservedVirtualDir(relDir) {
    return /^\/tic80\.com(\/|$)/i.test(relDir);
  }

  // TIC-80's console `cd` presumably chdir()s for real, which Emscripten's FS
  // module reflects in FS.cwd() - so dropped files land in whatever folder the
  // user is currently browsing in TIC-80. Falls back to the storage root if
  // that assumption turns out to be wrong (cwd not inside mounted storage) or
  // if cwd resolves into the reserved tic80.com virtual folder.
  function currentUploadDir(FS) {
    try {
      var cwd = FS.cwd();
      if (cwd && cwd.indexOf(mountDir) === 0 && !isReservedVirtualDir(toRelPath(cwd))) {
        return cwd;
      }
    } catch (e) { /* ignore */ }
    return mountDir;
  }

  function handleDroppedFiles(FS, fileList) {
    var rawCwd = null;
    try { rawCwd = FS.cwd(); } catch (e) { /* ignore */ }
    var dir = currentUploadDir(FS);
    var relDir = toRelPath(dir);
    var redirectedFromVirtual =
      rawCwd && rawCwd.indexOf(mountDir) === 0 && isReservedVirtualDir(toRelPath(rawCwd));
    // Since this shim can't independently verify whether FS.cwd() truly tracks
    // TIC-80's own idea of "current folder" (including inside SURF), always
    // name the actual destination back to the user rather than assuming they
    // know where "here" resolved to.
    var dirLabel = redirectedFromVirtual
      ? 'the root folder ("tic80.com" is a reserved online-cart folder, not real storage)'
      : (relDir === '/' ? 'the root folder' : ('"' + relDir + '"'));
    var files = Array.prototype.slice.call(fileList);
    var chain = Promise.resolve();
    var uploaded = 0;

    files.forEach(function (file) {
      chain = chain.then(function () {
        return file.arrayBuffer().then(function (buf) {
          var fsPath = joinPath(dir, file.name);
          var exists = true;
          try { FS.stat(fsPath); } catch (e) { exists = false; }
          if (exists && !window.confirm('Overwrite "' + file.name + '" in ' + dirLabel + '?')) {
            return;
          }
          FS.writeFile(fsPath, new Uint8Array(buf));
          uploaded++;
        });
      });
    });

    return chain.then(function () {
      if (!uploaded) return;
      return new Promise(function (resolve, reject) {
        FS.syncfs(false, function (err) {
          if (err) reject(err); else resolve();
        });
      }).then(function () {
        showNotice(
          'Uploaded ' + uploaded + ' file' + (uploaded === 1 ? '' : 's') +
          ' to ' + dirLabel + '.'
        );
      });
    });
  }

  function installDragAndDrop(FS) {
    var canvas = document.getElementById('canvas');
    if (!canvas) return;
    canvas.addEventListener('dragover', function (e) { e.preventDefault(); });
    canvas.addEventListener('drop', function (e) {
      e.preventDefault();
      if (mountDir === null) return;
      var fileList = e.dataTransfer && e.dataTransfer.files;
      if (!fileList || !fileList.length) return;
      handleDroppedFiles(FS, fileList).catch(function (err) {
        console.error('CloudyTIC80: drag-and-drop upload failed', err);
        showError('Could not upload the dropped file(s).');
      });
    });
  }

  function install(Module) {
    Module.preRun = Module.preRun || [];
    Module.preRun.push(function () {
      var FS = Module.FS;
      installDragAndDrop(FS);

      var realMount = FS.mount;
      FS.mount = function (type, opts, mountpoint) {
        if (mountDir === null) mountDir = mountpoint;
        return realMount.call(FS, type, opts, mountpoint);
      };

      var realSyncfs = FS.syncfs;
      FS.syncfs = function (populate, callback) {
        realSyncfs.call(FS, populate, function (err) {
          if (mountDir === null) { callback(err); return; }
          var work = populate ? populateFromServer(FS) : pushChangesToServer(FS);
          work.then(
            function () {
              hideError();
              callback(err);
            },
            function (workErr) {
              console.error('CloudyTIC80: ' + (populate ? 'loading from' : 'saving to') +
                ' the server failed', workErr);
              showError(
                populate
                  ? 'Could not load your files from the server. Working offline - reload to retry.'
                  : 'Could not save to the server! Your latest changes are NOT backed up. ' +
                    'Check your connection - CloudyTIC80 will keep retrying.'
              );
              // TIC-80 itself ignores this err argument, but pass it along anyway in
              // case that ever changes, and so nothing here masks the underlying
              // engine-reported error.
              callback(err || workErr);
            }
          );
        });
      };
    });
  }

  return { install: install };
})();
