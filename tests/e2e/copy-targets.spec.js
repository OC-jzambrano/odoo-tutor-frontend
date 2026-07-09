const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.ODOO_BASE_URL || "http://localhost:8069";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: BASE_URL,
  });
  await page.goto("/odoo");
  await expect(page.locator(".ai-owl-trigger")).toBeVisible();
});

test("highlights a copy target inside an in-chat instruction and copies it on click", async ({
  page,
}) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => {
    window.aiTutorDebug.pushTutorMessage(
      "Select Azure Interior in the Customer field.",
      [{ text: "Azure Interior", field: "partner_id", field_label: "Customer" }]
    );
  });

  const copyValue = page.locator("#chat-ui-container .ai-copy-value", {
    hasText: "Azure Interior",
  });
  await expect(copyValue).toBeVisible();

  await copyValue.click();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe("Azure Interior");

  await expect(copyValue).toHaveClass(/is-copied/);
});

test("does not highlight anything when the instruction has no copy targets", async ({
  page,
}) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => {
    window.aiTutorDebug.pushTutorMessage("Click Save.", []);
  });

  await expect(
    page.locator("#chat-ui-container").getByText("Click Save.")
  ).toBeVisible();
  await expect(page.locator("#chat-ui-container .ai-copy-value")).toHaveCount(0);
});

test("keeps a newline-wrapped copy target and trailing punctuation inline", async ({
  page,
}) => {
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  await page.evaluate(() => {
    window.aiTutorDebug.pushTutorMessage(
      "Good job. In the Product field, create a new storable product named\n**Product Z**\n.",
      [{ text: "Product Z", field: "name", field_label: "Product" }]
    );
  });

  const copyValue = page.locator("#chat-ui-container .ai-copy-value", {
    hasText: "Product Z",
  });
  await expect(copyValue).toBeVisible();

  const message = copyValue.locator("xpath=ancestor::*[contains(@class, 'nlux-comp-message')][1]");
  await expect(message).toContainText(
    "Good job. In the Product field, create a new storable product named Product Z."
  );

  const layout = await copyValue.evaluate((chip) => {
    const messageEl = chip.closest(".nlux-comp-message");
    const textBlock = messageEl?.querySelector(".nlux-markdown-container");
    const textNode = Array.from(textBlock?.childNodes || []).find(
      (node) =>
        node.nodeType === Node.TEXT_NODE &&
        node.textContent.includes("named ")
    );

    if (!textNode) return null;

    const index = textNode.textContent.indexOf("named ");
    const range = document.createRange();
    range.setStart(textNode, index);
    range.setEnd(textNode, index + "named ".length);
    const preceding = range.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();

    return {
      precedingY: Math.round(preceding.y),
      chipY: Math.round(chipBox.y),
      text: textBlock?.innerText || "",
    };
  });

  expect(layout).not.toBeNull();
  expect(Math.abs(layout.chipY - layout.precedingY)).toBeLessThanOrEqual(2);
  expect(layout.text).not.toMatch(/\n\s*\.\s*$/);
});

test("highlights a copy target in the owl-mode preview bubble and copies it on click without opening the chat", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.aiTutorDebug.showPreview(
      "Select Azure Interior in the Customer field.",
      new Date().toISOString(),
      [{ text: "Azure Interior", field: "partner_id", field_label: "Customer" }]
    );
  });

  const preview = page.locator(".ai-owl-preview");
  await expect(preview).toBeVisible();

  const copyValue = preview.locator(".ai-copy-value", { hasText: "Azure Interior" });
  await expect(copyValue).toBeVisible();

  await copyValue.click();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe("Azure Interior");

  // Clicking the copyable value must not bubble up into opening the chat.
  await expect(page.locator("#offcanvasAiSidebar")).not.toHaveClass(/show/);
  await expect(preview).toBeVisible();
});
