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
async function startPlayer(browser, user) {
  const context = await browser.newContext({ httpCredentials: { ...user, send: 'always' }, viewport: { width: 960, height: 640 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  return { context, page, errors };
}

// Clicks CLICK TO PLAY and waits for TIC-80's console to be up.
async function boot(page) {
  await page.locator('#game-frame').click();
  // Module.FS is only exported when the build's link flags took; the shim depends on it.
  await page.waitForFunction(() => window.Module && window.Module.FS, null, { timeout: 60_000 });
  await page.waitForTimeout(5000); // cart folder populated from the server, first console frames
  await page.locator('#canvas').focus();
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
    const { context, page, errors } = await startPlayer(browser, ALICE);
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(new URL(r.url()).pathname); });

    await boot(page);
    await typeCommand(page, 'save ' + name);

    // The browser sent it...
    await expect.poll(() => puts.some((p) => p.includes(name)), {
      timeout: 30_000,
      message: 'no PUT /dav/' + name + '* seen',
    }).toBe(true);

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

    // Survives a reload: the cart is pulled back down from the server into a fresh browser
    // profile (no local IndexedDB cache to fall back on).
    await context.close();
    const second = await startPlayer(browser, ALICE);
    const gets = [];
    second.page.on('request', (r) => { if (r.method() === 'GET') gets.push(new URL(r.url()).pathname); });
    await boot(second.page);
    await expect.poll(() => gets.includes('/dav/' + name + '.tic'), { timeout: 30_000 }).toBe(true);
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
