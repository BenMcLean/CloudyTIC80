// What a TIC-80 version bump (or any change here) must not break. The big one is the
// round trip: a cart saved in the real TIC-80 console in a real browser must end up on the
// server, readable by its owner and nobody else.
//
// The container is started with two accounts (see tests/README.md): alice and bob.
const { test, expect, request } = require('@playwright/test');

const ALICE = { username: 'alice', password: process.env.ALICE_PASSWORD || 'alicepw' };
const BOB = { username: 'bob', password: process.env.BOB_PASSWORD || 'bobpw' };

function api(baseURL, user) {
  return request.newContext({ baseURL, httpCredentials: { ...user, send: 'always' } });
}

async function listDav(ctx, path = '/dav/') {
  const res = await ctx.fetch(path, { method: 'PROPFIND', headers: { Depth: '1' } });
  return { status: res.status(), body: await res.text() };
}

// Opens the player page as `user`; nothing is started until boot().
async function startPlayer(browser, user, contextOptions = {}) {
  const context = await browser.newContext({ httpCredentials: { ...user, send: 'always' }, viewport: { width: 960, height: 640 }, ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  const log = [];
  page.on('pageerror', (e) => { errors.push(String(e)); log.push('pageerror: ' + e); });
  page.on('console', (m) => log.push(m.type() + ': ' + m.text()));
  page.on('requestfailed', (r) => log.push('requestfailed: ' + r.method() + ' ' + r.url()));
  // The player only starts its animation loop once the engine is up and the carts are loaded,
  // so counting frames is a real "the console is running" signal, unlike a fixed sleep (which
  // is how a slow first boot on a CI runner typed the command into a console that wasn't there).
  await page.addInitScript(() => {
    window.__frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { window.__frames++; cb(t); });
  });
  // THROTTLE=<n> slows the page's CPU n-fold, to reproduce a slow CI runner locally.
  if (process.env.THROTTLE) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  }
  await page.goto('/');
  return { context, page, errors, log };
}

// Clicks CLICK TO PLAY and waits for TIC-80's console to be up.
async function boot(page) {
  await page.locator('#game-frame').click();
  // Module.FS is only exported when the build's link flags took; the shim depends on it.
  await page.waitForFunction(() => window.Module && window.Module.FS, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__frames > 90, null, { timeout: 90_000 });
  await page.locator('#canvas').focus();
  // The console ignores keys for a moment after it starts (a command typed into that window
  // loses its first characters). It echoes every line it accepts to the browser console as
  // ">text", so press Enter until an empty prompt is echoed back: from then on it takes input.
  let prompts = 0;
  page.on('console', (m) => { if (/^>/.test(m.text())) prompts++; });
  await expect.poll(async () => {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    return prompts;
  }, { timeout: 60_000, message: 'the console never accepted input' }).toBeGreaterThan(0);
}

async function typeCommand(page, text) {
  await page.keyboard.type(text, { delay: 60 });
  await page.keyboard.press('Enter');
}

test.describe('access control', () => {
  test('the page and the dav folder demand a login; favicon does not', async ({ baseURL }) => {
    const anon = await request.newContext({ baseURL });
    expect((await anon.get('/')).status()).toBe(401);
    expect((await anon.fetch('/dav/', { method: 'PROPFIND' })).status()).toBe(401);
    expect((await anon.get('/favicon.ico')).status()).toBe(200);
    const bad = await request.newContext({ baseURL, httpCredentials: { username: 'alice', password: 'wrong', send: 'always' } });
    expect((await bad.get('/')).status()).toBe(401);
  });

  test('config.js names a tic80.com site (the build cross-checks which one against the engine)', async ({ baseURL }) => {
    const alice = await api(baseURL, ALICE);
    const res = await alice.get('/config.js');
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(/upstream: "https:\/\/(dev\.)?tic80\.com"/);
  });
});

test.describe('the page', () => {
  test("is TIC-80's own page with our insertions, in the right order", async ({ baseURL }) => {
    const alice = await api(baseURL, ALICE);
    const html = await (await alice.get('/')).text();
    const iConfig = html.indexOf('src="config.js"');
    const iShim = html.indexOf('src="webdav-shim.js"');
    const iModule = html.search(/\b(?:var|let|const)\s+Module\s*=/);
    const iInstall = html.indexOf('CloudyTIC80Shim.install(Module)');
    expect(iConfig).toBeGreaterThan(-1);
    expect(iShim).toBeGreaterThan(iConfig);
    expect(iModule).toBeGreaterThan(iShim);
    expect(iInstall).toBeGreaterThan(iModule);
    expect(html).toContain('CLICK TO PLAY');
  });

  test('the engine is not loaded until CLICK TO PLAY is clicked', async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    const requested = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await page.waitForTimeout(1500);
    expect(requested).not.toContain('/tic80.js');
    expect(await page.evaluate(() => typeof window.Module.FS)).toBe('undefined');
    await page.locator('#game-frame').click();
    await expect.poll(() => requested.includes('/tic80.js')).toBe(true);
    await context.close();
  });
});

test.describe('saving to the server', () => {
  test('a cart saved in the TIC-80 console lands on the server, and only for its owner', async ({ browser, baseURL }) => {
    const name = 'e2e' + Date.now().toString(36);
    const { context, page, errors, log } = await startPlayer(browser, ALICE);
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(new URL(r.url()).pathname); });

    await boot(page);
    await typeCommand(page, 'save ' + name);

    // The browser sent it...
    try {
      await expect.poll(() => puts.some((p) => p.includes(name)), { timeout: 30_000 }).toBe(true);
    } catch (e) {
      const frames = await page.evaluate(() => window.__frames).catch(() => '?');
      throw new Error('no PUT /dav/' + name + '* seen (frames rendered: ' + frames + ', PUTs: ' +
        JSON.stringify(puts) + ')\nPAGE LOG:\n' + log.slice(-40).join('\n'));
    }

    // ...and, checked from outside the browser, the server really has it, as a real cart.
    const alice = await api(baseURL, ALICE);
    let got;
    await expect.poll(async () => {
      got = await alice.get('/dav/' + name + '.tic');
      return got.status();
    }, { timeout: 30_000 }).toBe(200);
    expect((await got.body()).length).toBeGreaterThan(100);

    // Bob must not see it, in his listing or by name.
    const bob = await api(baseURL, BOB);
    expect((await listDav(bob)).body).not.toContain(name);
    expect((await bob.get('/dav/' + name + '.tic')).status()).toBe(404);

    // No error banner from the shim, and no uncaught page errors.
    await expect(page.getByText(/Could not (save|load)/)).toHaveCount(0);
    expect(errors).toEqual([]);

    // Survives a reload: a fresh browser profile (no local IndexedDB cache to fall back on) lists
    // the cart and reads it back, straight from the server.
    await context.close();
    const second = await startPlayer(browser, ALICE);
    await boot(second.page);
    const listed = await second.page.evaluate(() =>
      window.Module.FS.readdir(CloudyTIC80Shim.mountDir()).filter((n) => n !== '.' && n !== '..'));
    expect(listed).toContain(name + '.tic');
    const size = await second.page.evaluate((n) =>
      window.Module.FS.readFile(CloudyTIC80Shim.mountDir() + '/' + n).length, name + '.tic');
    expect(size).toBeGreaterThan(100);
    await second.context.close();

    await alice.delete('/dav/' + name + '.tic');
  });

  test('one account cannot see or reach another account\'s carts', async ({ baseURL }) => {
    const alice = await api(baseURL, ALICE);
    const bob = await api(baseURL, BOB);
    const put = await alice.put('/dav/isolation-probe.tic', { data: Buffer.from('probe') });
    expect(put.status()).toBeLessThan(300);
    expect((await listDav(bob)).body).not.toContain('isolation-probe');
    expect((await bob.get('/dav/isolation-probe.tic')).status()).toBe(404);
    await alice.delete('/dav/isolation-probe.tic');
  });
});

test.describe('server and browser stay in step', () => {
  const ls = (page) => page.evaluate(() => {
    const FS = window.Module.FS;
    return FS.readdir(CloudyTIC80Shim.mountDir()).filter((n) => n !== '.' && n !== '..');
  });

  test('a cart inserted on the server shows up in a running session, and a deleted one goes', async ({ browser, baseURL }) => {
    const name = 'ins' + Date.now().toString(36) + '.tic';
    const alice = await api(baseURL, ALICE);
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    expect(await ls(page)).not.toContain(name);

    expect((await alice.put('/dav/' + name, { data: Buffer.from('from the teacher') })).status()).toBeLessThan(300);
    expect(await ls(page)).toContain(name);
    expect(await page.evaluate((n) => {
      const FS = window.Module.FS;
      return new TextDecoder().decode(FS.readFile(CloudyTIC80Shim.mountDir() + '/' + n));
    }, name)).toBe('from the teacher');

    await alice.delete('/dav/' + name);
    expect(await ls(page)).not.toContain(name);
    await context.close();
  });

  test('a save the server refuses fails: nothing is written, and the page says so', async ({ browser, baseURL }) => {
    const name = 'fail' + Date.now().toString(36);
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    await page.route('**/dav/**', (route) =>
      route.request().method() === 'PUT' || route.request().method() === 'PROPFIND'
        ? route.fulfill({ status: 503, body: 'down' })
        : route.continue());
    await typeCommand(page, 'save ' + name);
    await expect(page.getByText(/NOT SAVED/)).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/dav/**');
    expect(await ls(page)).not.toContain(name + '.tic');
    const alice = await api(baseURL, ALICE);
    expect((await alice.get('/dav/' + name + '.tic')).status()).toBe(404);
    await context.close();
  });

  const read = (page, n) => page.evaluate((name) => new TextDecoder().decode(
    window.Module.FS.readFile(CloudyTIC80Shim.mountDir() + '/' + name)), n);

  test('every read asks the server: a cart replaced on the server is read as replaced', async ({ browser, baseURL }) => {
    const name = 'fresh' + Date.now().toString(36) + '.tic';
    const alice = await api(baseURL, ALICE);
    await alice.put('/dav/' + name, { data: Buffer.from('one') });
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    expect(await read(page, name)).toBe('one');
    await alice.put('/dav/' + name, { data: Buffer.from('two') });
    expect(await read(page, name)).toBe('two');
    await alice.delete('/dav/' + name);
    await expect(read(page, name)).rejects.toThrow();
    await context.close();
  });

  test('when the server cannot be reached, reads and listings fail loudly instead of using the local copy', async ({ browser, baseURL }) => {
    const name = 'down' + Date.now().toString(36) + '.tic';
    const alice = await api(baseURL, ALICE);
    await alice.put('/dav/' + name, { data: Buffer.from('there') });
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    expect(await read(page, name)).toBe('there');
    await page.route('**/dav/**', (route) => route.fulfill({ status: 503, body: 'down' }));
    await expect(read(page, name)).rejects.toThrow();
    await expect(ls(page)).rejects.toThrow();
    await expect(page.getByText(/COULD NOT READ FROM THE SERVER/)).toBeVisible();
    await page.unroute('**/dav/**');
    expect(await ls(page)).toContain(name);
    await expect(page.getByText(/COULD NOT READ FROM THE SERVER/)).toBeHidden();
    await context.close();
    await alice.delete('/dav/' + name);
  });
});

test.describe('option defaults', () => {
  test('crt is off by default, and the editor is forced to tabs, 4 wide', async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    const options = await page.evaluate(() => {
      const path = CloudyTIC80Shim.mountDir() + '/' + window.CloudyTIC80Config.optionsPath;
      return JSON.parse(window.Module.FS.readFile(path, { encoding: 'utf8' }));
    });
    expect(options.crt).toBe(false);
    expect(options.tabMode).toBe(1);
    expect(options.tabSize).toBe(4);
    await context.close();
  });

  const optionsOf = (page) => page.evaluate(() => {
    const path = CloudyTIC80Shim.mountDir() + '/' + window.CloudyTIC80Config.optionsPath;
    return JSON.parse(window.Module.FS.readFile(path, { encoding: 'utf8' }));
  });

  test("the owner's tic80-options.json is served to logged-in users only, seeded with the defaults", async ({ baseURL }) => {
    const anon = await request.newContext({ baseURL });
    expect((await anon.get('/tic80-options.json')).status()).toBe(401);
    const alice = await api(baseURL, ALICE);
    const res = await alice.get('/tic80-options.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.json()).toEqual({ defaults: { crt: false }, forced: { tabMode: 1, tabSize: 4 } });
  });

  test("the owner's file replaces the built-in values key by key", async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    await page.route('**/tic80-options.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ defaults: { crt: true, volume: 7 }, forced: { tabSize: 2 } }),
    }));
    await boot(page);
    const options = await optionsOf(page);
    expect(options.crt).toBe(true);
    expect(options.volume).toBe(7);
    expect(options.tabSize).toBe(2);
    expect(options.tabMode).toBe(1);   // not mentioned by the owner: the built-in value stays
    await context.close();
  });

  test('no file means the built-in values; a broken file is reported, not ignored', async ({ browser }) => {
    const none = await startPlayer(browser, ALICE);
    await none.page.route('**/tic80-options.json', (route) => route.fulfill({ status: 404, body: '' }));
    await boot(none.page);
    expect((await optionsOf(none.page)).tabSize).toBe(4);
    await expect(none.page.getByText(/tic80-options\.json/)).toHaveCount(0);
    await none.context.close();

    const broken = await startPlayer(browser, ALICE);
    await broken.page.route('**/tic80-options.json', (route) => route.fulfill({ status: 200, body: '{ not json' }));
    await boot(broken.page);
    expect((await optionsOf(broken.page)).tabSize).toBe(4);
    await expect(broken.page.getByText(/tic80-options\.json is not usable/)).toBeVisible();
    await broken.context.close();
  });
});

test.describe('TIC-80 console features we touch', () => {
  test('`add` opens the file dialog (broken in some upstream versions)', async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    await typeCommand(page, 'add');
    await expect(page.locator('#add-modal')).toBeVisible({ timeout: 15_000 });
    await context.close();
  });

  test('requests for tic80.com paths go straight to tic80.com, not to this server', async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    const hitOurServer = [];
    const hitUpstream = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (/^\/(json|cart\/|export\/|js\/)/.test(u.pathname)) {
        (u.hostname === 'tic80.com' ? hitUpstream : hitOurServer).push(r.url());
      }
    });
    // The test machine need not reach tic80.com: answer for it, so only the destination matters.
    await page.route('https://tic80.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{}',
      }));
    await boot(page);
    await typeCommand(page, 'surf');
    await expect.poll(() => hitUpstream.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(hitOurServer).toEqual([]);
    await context.close();
  });
});

// The code editor is drawn on a canvas, so there is no text to read back from the page. Instead
// the tests type into a fresh cart, `save` it from the console, and read the code out of the
// saved .tic file (the code chunk is stored as plain text).
test.describe('code editor keys', () => {
  const pause = (page, ms = 500) => page.waitForTimeout(ms);
  // The engine reads keys once per frame and loses ones that come and go within a frame, so each
  // key is held for a moment, and given a moment to take effect before the next one.
  async function tap(page, key) {
    await page.keyboard.press(key, { delay: 100 });
    await page.waitForTimeout(150);
  }

  // Esc toggles between the console and the editor, but the engine drops it now and then, and
  // nothing on the canvas says which one is showing. The console echoes every line it accepts
  // to the browser console as ">text", so pressing Enter tells them apart: an echo means the
  // console is up (in the editor, Enter only adds a blank line at the caret, which is harmless
  // here: the tests have the caret at the end of what they typed, or clear the code afterwards).
  const echoes = new WeakMap();
  async function consoleIsUp(page) {
    if (!echoes.has(page)) {
      echoes.set(page, 0);
      page.on('console', (m) => { if (/^>/.test(m.text())) echoes.set(page, echoes.get(page) + 1); });
    }
    const before = echoes.get(page);
    await page.keyboard.press('Enter', { delay: 100 });
    await pause(page);
    return echoes.get(page) > before;
  }

  async function switchMode(page, wantConsole) {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Escape', { delay: 150 });
      await pause(page);
      if ((await consoleIsUp(page)) === wantConsole) return;
    }
    throw new Error('could not switch to the ' + (wantConsole ? 'console' : 'editor'));
  }

  // Fresh cart, open in the code editor with its code emptied (`new` leaves a template there).
  async function openEditor(page) {
    await typeCommand(page, 'new lua');
    await pause(page);
    await switchMode(page, false);
    await tap(page, 'Control+A');
    await tap(page, 'Backspace');
    await pause(page);   // keys typed straight after the clear lose their first character
  }

  // Back to the console, save under a new name, and return the saved cart as text.
  async function savedCode(page) {
    const name = 'keys' + Date.now().toString(36);
    await switchMode(page, true);
    await typeCommand(page, 'save ' + name);
    const file = name + '.tic';
    let code = null;
    await expect.poll(() => page.evaluate((f) => {
      try { return window.Module.FS.readFile(CloudyTIC80Shim.mountDir() + '/' + f, { encoding: 'binary' }).length; }
      catch (e) { return 0; }
    }, file), { timeout: 30_000, message: 'the cart was never saved' }).toBeGreaterThan(0);
    // A .tic file is a list of chunks: 1 byte type (low 5 bits) + bank, 2 bytes size (LE), 1 reserved, then data.
    // Type 5 is the code. Joined across banks, it is the cart's source as typed.
    code = await page.evaluate((f) => {
      const bytes = window.Module.FS.readFile(CloudyTIC80Shim.mountDir() + '/' + f, { encoding: 'binary' });
      let out = '';
      for (let i = 0; i + 4 <= bytes.length;) {
        const type = bytes[i] & 0x1f;
        const size = bytes[i + 1] | (bytes[i + 2] << 8);
        if (type === 5) out += new TextDecoder().decode(bytes.subarray(i + 4, i + 4 + size));
        i += 4 + size;
      }
      return out;
    }, file);
    return { code, file };
  }

  async function cleanup(baseURL, file) {
    await (await api(baseURL, ALICE)).delete('/dav/' + file);
  }

  test('Home and End move to the start and end of the current line', async ({ browser, baseURL }) => {
    const { context, page } = await startPlayer(browser, ALICE);
    await boot(page);
    await openEditor(page);
    await page.keyboard.type('one', { delay: 60 });
    await tap(page, 'Enter');
    await page.keyboard.type('two', { delay: 60 });
    await tap(page, 'Home');
    await page.keyboard.type('X', { delay: 60 });        // start of line 2
    await tap(page, 'ArrowUp');
    await tap(page, 'End');
    await page.keyboard.type('Y', { delay: 60 });        // end of line 1
    await tap(page, 'ArrowDown');
    await tap(page, 'End');
    await page.keyboard.type('Z', { delay: 60 });        // end of line 2
    const { code, file } = await savedCode(page);
    expect(code).toContain('oneY\nXtwoZ');
    await context.close();
    await cleanup(baseURL, file);
  });

  // Copy is checked on its own, from the browser's side: the saved cart can only prove paste.
  // The clipboard starts with a sentinel, so only a real copy can make this pass.
  test('Ctrl+C puts the selected text on the browser clipboard', async ({ browser }) => {
    const { context, page } = await startPlayer(browser, ALICE, { permissions: ['clipboard-read', 'clipboard-write'] });
    await boot(page);
    await openEditor(page);
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
    await page.keyboard.type('copy me', { delay: 60 });
    await tap(page, 'Control+A');
    await tap(page, 'Control+C');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toBe('copy me');
    await context.close();
  });

  test('copy then paste inside the editor round-trips the text', async ({ browser, baseURL }) => {
    const { context, page } = await startPlayer(browser, ALICE, { permissions: ['clipboard-read', 'clipboard-write'] });
    await boot(page);
    await openEditor(page);
    await page.keyboard.type('hello', { delay: 60 });
    await tap(page, 'Control+A');
    await tap(page, 'Control+C');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toBe('hello');
    await tap(page, 'End');                    // drop the selection, caret after "hello"
    await tap(page, 'Control+V');
    const { code, file } = await savedCode(page);
    expect(code).toContain('hellohello');
    await context.close();
    await cleanup(baseURL, file);
  });

  test('Ctrl+V pastes text that came from outside the editor', async ({ browser, baseURL }) => {
    const { context, page } = await startPlayer(browser, ALICE, { permissions: ['clipboard-read', 'clipboard-write'] });
    await boot(page);
    await openEditor(page);
    await page.evaluate(() => navigator.clipboard.writeText('from outside'));
    await tap(page, 'Control+V');
    const { code, file } = await savedCode(page);
    expect(code).toContain('from outside');
    await context.close();
    await cleanup(baseURL, file);
  });
});
