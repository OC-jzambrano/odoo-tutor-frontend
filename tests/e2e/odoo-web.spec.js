const { test, expect } = require("@playwright/test");

test("loads the authenticated Odoo web client", async ({ page }) => {
  await page.goto("/web");
  await expect(
    page.locator(".o_web_client"),
    "Odoo did not load an authenticated web client. Run `npm run test:e2e:auth` to refresh the saved login.",
  ).toBeVisible();
});
