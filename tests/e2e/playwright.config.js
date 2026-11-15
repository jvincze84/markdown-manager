// A tesztek egy közös, futó szerveren dolgoznak (git állapot!) → sorban, egy workerrel futnak.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: process.env.PW_OUTPUT || 'test-results',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:18080',
    viewport: { width: 1400, height: 850 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
