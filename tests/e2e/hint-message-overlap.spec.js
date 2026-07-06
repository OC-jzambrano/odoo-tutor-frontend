const { test, expect } = require("@playwright/test");

// Regression test: the context hint is a floating overlay anchored above the
// composer, like a popup/mini-modal — it is allowed to visually sit on top
// of the last chat message. What it must never do is reserve scroll space
// (padding-bottom) in the conversation container, because that shifts the
// message list itself, making the hint look like it's "part of" the chat
// flow instead of a popup in front of it. See ai_sidebar.js#_syncHintScrollPadding.
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

  await page.goto("/odoo?debug=assets");
  await expect(page.locator(".ai-owl-trigger")).toBeVisible();
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  const composer = page.locator(
    "#chat-ui-container .nlux-comp-composer textarea",
  );
  await composer.fill("dependency-control-project");
  await composer.press("Enter");
  await expect(page.locator(".ai-exercise-choice-yes")).toBeVisible();
  await page.locator(".ai-exercise-choice-yes").click();

  await expect(
    page.getByText("Create the task Design inside the project.", { exact: true }).first(),
  ).toBeVisible();

  // Push two more tutor instructions so the conversation fills toward the
  // bottom of the scroll area, matching the real-world scenario in the bug
  // report where several message bubbles already sat near the composer.
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

  // The message must not have shifted to make room for the hint — the hint
  // is a popup that floats in front of the chat, not an extra chat bubble.
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
