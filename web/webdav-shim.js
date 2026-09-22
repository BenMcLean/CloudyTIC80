// Redirects TIC-80's Emscripten virtual filesystem (MEMFS/IDBFS, mounted by TIC-80's
// own compiled code) to per-user WebDAV storage on the server, without touching TIC-80
// itself. Hooks FS.mount (to learn TIC-80's cart-storage mount path) and FS.syncfs
// (TIC-80's own persistence trigger) before TIC-80's main() runs.
var CloudyTIC80Shim = (function () {
  var DAV_PREFIX = '/dav';
  var mountDir = null;
  var knownFiles = Object.create(null);

  function davUrl(relPath) {
    return DAV_PREFIX + relPath;
  }

  function toRelPath(fullPath) {
    if (fullPath === mountDir) return '/';
    var rel = fullPath.slice(mountDir.length);
    if (rel[0] !== '/') rel = '/' + rel;
    return rel;
  }

  function xhrRequest(method, relPath, body, responseType) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, davUrl(relPath), true);
      if (responseType) xhr.responseType = responseType;
      if (method === 'PROPFIND') xhr.setRequestHeader('Depth', '1');
      xhr.onloadend = function () { resolve(xhr); };
      xhr.onerror = function () { resolve(xhr); };
      xhr.send(body || null);
    });
  }

  function fetchDirRecursive(FS, fsDir, relDir) {
    return xhrRequest('PROPFIND', relDir).then(function (xhr) {
      if ((xhr.status !== 207 && xhr.status !== 200) || !xhr.responseText) return;
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
      if (xhr.status !== 200) return;
      FS.writeFile(fsPath, new Uint8Array(xhr.response));
      try {
        var st = FS.stat(fsPath);
        knownFiles[fsPath] = { size: st.size, mtime: st.mtime.getTime() };
      } catch (e) { /* ignore */ }
    });
  }

  function populateFromServer(FS) {
    return fetchDirRecursive(FS, mountDir, '/');
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

    entries.forEach(function (entry) {
      seen[entry.path] = true;
      var known = knownFiles[entry.path];
      if (entry.dir) {
        if (!known) {
          chain = chain.then(function () {
            return xhrRequest('MKCOL', toRelPath(entry.path)).then(function () {
              knownFiles[entry.path] = { dir: true };
            });
          });
        }
        return;
      }
      if (!known || known.size !== entry.size || known.mtime !== entry.mtime) {
        chain = chain.then(function () {
          var data;
          try { data = FS.readFile(entry.path); } catch (e) { return; }
          return xhrRequest('PUT', toRelPath(entry.path), data).then(function () {
            knownFiles[entry.path] = { size: entry.size, mtime: entry.mtime };
          });
        });
      }
    });

    Object.keys(knownFiles).forEach(function (path) {
      if (!seen[path]) {
        chain = chain.then(function () {
          return xhrRequest('DELETE', toRelPath(path)).then(function () {
            delete knownFiles[path];
          });
        });
      }
    });

    return chain;
  }

  function install(Module) {
    Module.preRun = Module.preRun || [];
    Module.preRun.push(function () {
      var FS = Module.FS;

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
          work.then(function () { callback(err); }, function () { callback(err); });
        });
      };
    });
  }

  return { install: install };
})();
