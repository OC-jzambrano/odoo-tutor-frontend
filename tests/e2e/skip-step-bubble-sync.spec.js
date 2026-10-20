const { test, expect } = require("@playwright/test");

// Verify that skipping from the floating bubble also adds the response to chat history.
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

  // Close the sidebar to use the floating bubble.
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

  // Confirm the skipped instruction appears in chat history after reopening.
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);
  await expect(
    page.getByText("Enter the opportunity name.", { exact: true }),
  ).toBeVisible();
});
