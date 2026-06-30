const { existsSync } = require("node:fs");
const { defineConfig, devices } = require("@playwright/test");

const baseURL = process.env.ODOO_BASE_URL || "http://localhost:8069";
const authFile = "tests/e2e/.auth/user.json";

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/**/*.spec.js", "frontend/e2e/**/*.spec.js"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    storageState: existsSync(authFile) ? authFile : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
