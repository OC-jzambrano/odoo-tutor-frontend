const { test, expect } = require("@playwright/test");

// Regression test: the context hint is an absolutely-positioned overlay
// anchored to the bottom of the chat panel. Without reserved scroll space,
// it simply floats on top of whatever message happens to be last in the
// conversation, covering its text. Fix: ai_sidebar.js#_syncHintScrollPadding
// adds padding-bottom to the nlux conversation container equal to the
// hint's own measured height whenever it's shown.
test("context hint does not visually overlap the last chat message", async ({ page }) => {
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

  await page.evaluate(() =>
    window.aiTutorDebug.showHint(
      "If a new empty task box appears automatically, type directly there. Otherwise click Quick add again.",
    ),
  );

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();

  const lastMessage = page
    .locator("#chat-ui-container .nlux-comp-chatItem--received .nlux-markdown-container")
    .last();

  const [hintBox, messageBox] = await Promise.all([
    hint.boundingBox(),
    lastMessage.boundingBox(),
  ]);

  expect(hintBox).not.toBeNull();
  expect(messageBox).not.toBeNull();

  const overlaps =
    hintBox.x < messageBox.x + messageBox.width &&
    hintBox.x + hintBox.width > messageBox.x &&
    hintBox.y < messageBox.y + messageBox.height &&
    hintBox.y + hintBox.height > messageBox.y;

  expect(overlaps).toBe(false);
});
