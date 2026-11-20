const { test, expect } = require("@playwright/test");

// Ensure the floating context hint overlays the chat without reserving scroll padding.
test("context hint overlays the chat without shifting the message layout", async ({ page }) => {
  let wsRef;

  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    wsRef = ws;
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-hint-overlap-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "chat") return;

      ws.send(
        JSON.stringify({
          type: "chat_response_complete",
          status: "complete",
          response: "Create the task Design inside the project.",
          exercise_id: "ex-project",
          current_step: 0,
          is_optional: true,
        }),
      );
    });
  });

  await page.goto("/odoo/crm?debug=assets");
  await expect(page.locator(".ai-owl-trigger")).toBeVisible();
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  const composer = page.locator(
    "#chat-ui-container .nlux-comp-composer textarea",
  );
  await composer.fill("dependency-control-project");
  await composer.press("Enter");
  await expect(page.locator(".ai-exercise-confirmation-choice.is-yes")).toBeVisible();
  await page.locator(".ai-exercise-confirmation-choice.is-yes").click();

  await expect(
    page.getByText("Create the task Design inside the project.", { exact: true }).first(),
  ).toBeVisible();

  // Push two more tutor instructions to fill the conversation near the composer.
  wsRef.send(
    JSON.stringify({
      type: "tutor_push",
      response:
        "Please enter the task title exactly as \"Design\" without any extra spaces in the Task Title field. Remove the trailing space after \"Design\" to proceed.",
      exercise_id: "ex-project",
      timestamp: new Date().toISOString(),
    }),
  );
  await expect(page.getByText(/Remove the trailing space after/)).toBeVisible();

  wsRef.send(
    JSON.stringify({
      type: "tutor_push",
      response:
        "Please change the field labeled \"Task Title?\" to \"Design\" instead of \"Task Title\". Make sure to use the exact label \"Task Title?\" when entering the task name.",
      exercise_id: "ex-project",
      timestamp: new Date().toISOString(),
    }),
  );
  await expect(page.getByText(/Make sure to use the exact label/)).toBeVisible();

  const lastMessage = page
    .locator("#chat-ui-container .nlux-comp-chatItem--received .nlux-markdown-container")
    .last();

  const messageBoxBefore = await lastMessage.boundingBox();
  expect(messageBoxBefore).not.toBeNull();

  await page.evaluate(() =>
    window.aiTutorDebug.showHint(
      "If a new empty task box appears automatically, type directly there. Otherwise click Quick add again.",
    ),
  );

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();

  // Verify the floating hint did not shift the last chat message position.
  const messageBoxAfter = await lastMessage.boundingBox();
  expect(messageBoxAfter).not.toBeNull();
  expect(messageBoxAfter.y).toBeCloseTo(messageBoxBefore.y, 0);

  const conversationPaddingBottom = await page.evaluate(() => {
    const conv = document.querySelector(
      "#chat-ui-container .nlux-conversation-container",
    );
    return conv ? conv.style.paddingBottom : null;
  });
  expect(conversationPaddingBottom).toBe("");
});
