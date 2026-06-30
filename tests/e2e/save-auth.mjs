import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const baseURL = process.env.ODOO_BASE_URL || "http://localhost:8069";
const database = process.env.ODOO_DATABASE || "odoo19_local";
const login = process.env.ODOO_LOGIN || "admin";
const password = process.env.ODOO_PASSWORD || "admin";
const authFile = resolve("tests/e2e/.auth/user.json");

await mkdir(dirname(authFile), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

console.log(`Authenticating ${login} on ${database} at ${baseURL}`);

try {
  const response = await page.request.post(`${baseURL}/web/session/authenticate`, {
    data: {
      jsonrpc: "2.0",
      params: { db: database, login, password },
    },
  });
  const payload = await response.json();
  if (!response.ok() || !payload?.result?.uid) {
    throw new Error(payload?.error?.data?.message || "Odoo authentication failed");
  }
  await page.goto(`${baseURL}/odoo`, { waitUntil: "domcontentloaded" });
  await page.locator(".o_web_client").waitFor({ state: "visible" });
  await context.storageState({ path: authFile });
  console.log(`Authentication state saved to ${authFile}`);
} finally {
  await browser.close();
}
