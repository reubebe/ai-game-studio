import { defineConfig, devices } from "@playwright/test";

// UI tests run against the browser preview (in-memory projects, scripted AI provider).
// The real desktop app is covered by its own self-test: <app> --smoke-test <folder>.
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1480, height: 920 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1480, height: 920 } } }],
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
