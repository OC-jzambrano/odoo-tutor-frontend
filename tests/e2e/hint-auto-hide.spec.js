const { test, expect } = require("@playwright/test");

// Real-time timers: the hint auto-hide window is 15s, so these tests
// deliberately wait past it. Generous per-test timeout to accommodate.
test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/odoo");
  await expect(page.locator(".ai-owl-trigger")).toBeVisible();
});

test("in-chat context hint auto-hides after 15s", async ({ page }) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => window.aiTutorDebug.showHint("Playwright auto-hide check"));

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();
  await expect(page.locator(".ai-inline-hint-text")).toHaveText("Playwright auto-hide check");

  await page.waitForTimeout(16_000);

  await expect(hint).toHaveCount(0);
});

test("hovering the in-chat hint pauses the countdown, leaving resumes it", async ({ page }) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => window.aiTutorDebug.showHint("Playwright hover check"));

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();

  await hint.hover();
  await page.waitForTimeout(16_000);
  await expect(hint).toBeVisible(); // still visible: hover paused the timer

  // Move the mouse elsewhere to trigger mouseleave and resume the timer.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(16_000);
  await expect(hint).toHaveCount(0);
});

test("closing the in-chat hint with the x button works immediately", async ({ page }) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => window.aiTutorDebug.showHint("Playwright close check"));

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();

  await page.locator(".ai-inline-hint-close").click();
  await expect(hint).toHaveCount(0);
});

test("owl-mode preview bubble auto-hides after 15s", async ({ page }) => {
  // Chat must be closed for the owl-mode preview to be eligible to show.
  await page.evaluate(() => window.aiTutorDebug.showPreview("Playwright owl preview check"));

  const preview = page.locator(".ai-owl-preview");
  await expect(preview).toBeVisible();
  await expect(page.locator(".ai-owl-preview-text")).toHaveText("Playwright owl preview check");

  await page.waitForTimeout(16_000);

  await expect(preview).toHaveCount(0);
});

test("clicking the owl-mode preview opens the chat", async ({ page }) => {
  await page.evaluate(() => window.aiTutorDebug.showPreview("Playwright owl click check"));

  const preview = page.locator(".ai-owl-preview");
  await expect(preview).toBeVisible();

  await preview.click();

  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);
  await expect(preview).toHaveCount(0);
});

test("closing the owl-mode preview with the x button works immediately", async ({ page }) => {
  await page.evaluate(() => window.aiTutorDebug.showPreview("Playwright owl close check"));

  const preview = page.locator(".ai-owl-preview");
  await expect(preview).toBeVisible();

  await page.locator(".ai-owl-preview-close").click();
  await expect(preview).toHaveCount(0);
});
