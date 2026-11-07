import { defineConfig, devices } from "@playwright/test";

const screen = { viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: true,
  // Retries would hide the flakiness these tests exist to catch.
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "node test/browser/server.mjs 4173",
    url: "http://127.0.0.1:4173/test/browser/harness.html",
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...screen } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], ...screen } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...screen } },
  ],
});
