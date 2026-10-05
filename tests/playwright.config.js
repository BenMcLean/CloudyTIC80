// Runs against an already-running container (see tests/README.md). Nothing here starts one.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 90_000,
  workers: 1,          // one container, one shared set of test accounts
  retries: 0,          // a flaky release gate is a broken release gate
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    // Full Chromium in its new headless mode (not the separate headless-shell build): closer to
    // a real browser, and one download fewer.
    channel: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Software GL: the sokol player needs WebGL2 and CI runners have no GPU.
    launchOptions: {
      // Optional: a Chromium/Chrome you already have, for machines where `playwright install` can't run.
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
