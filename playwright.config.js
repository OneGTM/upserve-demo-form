// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  // The suite drives one page with stubbed services — no shared state, so it
  // parallelises cleanly.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
    // Every test asserts on visible, user-facing behaviour.
    actionTimeout: 5000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // TJ's mobile concern: the form has to hold up at 390px too.
    { name: 'mobile', use: { ...devices['Pixel 5'] } }   // chromium at 393px
  ]
});
