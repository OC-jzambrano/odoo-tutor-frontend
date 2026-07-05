const { test, expect } = require("@playwright/test");

// Regression test for the bug where skipping a step from the floating
// "owl bubble" (visible while the chat sidebar is closed) advanced the
// bubble's own preview text but never appeared in the actual chat
// conversation once the sidebar was reopened. Root cause: the bubble had
// its own separate aiWs.chat() call that only updated its local preview
// state, instead of going through the same code path the in-chat skip
// button uses to push the response into the nlux conversation.
test("skipping a step from the owl bubble is reflected in the chat once reopened", async ({
  page,
}) => {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-bubble-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));

      if (message.type !== "chat") return;

      if (message.exercise_action === "next") {
        ws.send(
          JSON.stringify({
            type: "chat_response_complete",
            status: "complete",
            response: "Enter the opportunity name.",
            exercise_id: "ex-crm",
            current_step: 1,
            is_optional: true,
          }),
        );
        return;
      }

      if (message.exercise_action === "start") {
        ws.send(
          JSON.stringify({
            type: "chat_response_complete",
            status: "complete",
            response: "Click New.",
            exercise_id: "ex-crm",
            current_step: 0,
            is_optional: true,
          }),
        );
        return;
      }

      ws.send(
        JSON.stringify({
          type: "chat_response_complete",
          status: "complete",
          response: "Do you want to start this exercise?",
          exercise_id: "ex-crm",
          current_step: null,
          is_optional: false,
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
  await composer.fill("crm-create-opportunity-manual");
  await composer.press("Enter");

  await expect(page.locator(".ai-exercise-choice-yes")).toBeVisible();

  // Close the sidebar so the exchange continues through the floating
  // "owl bubble" surface instead of the in-chat panel.
  await page.locator("#offcanvasAiSidebar .btn-close").click();
  await expect(page.locator(".ai-owl-exercise-choice-yes")).toBeVisible();
  await page.locator(".ai-owl-exercise-choice-yes").click();

  await expect(page.locator(".ai-owl-preview-text")).toHaveText("Click New.");

  const bubbleSkipButton = page.locator(".ai-owl-trigger-skip");
  await expect(bubbleSkipButton).toBeVisible();
  await bubbleSkipButton.click();

  await expect(page.locator(".ai-owl-preview-text")).toHaveText(
    "Enter the opportunity name.",
  );

  // The real assertion: reopening the sidebar must show the skip-produced
  // instruction in the actual chat history, not just in the bubble preview.
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);
  await expect(
    page.getByText("Enter the opportunity name.", { exact: true }),
  ).toBeVisible();
});
