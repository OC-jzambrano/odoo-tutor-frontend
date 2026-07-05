const { test, expect } = require("@playwright/test");

// Regression test: skipping a step from the floating "owl bubble" while the
// chat sidebar is closed must not jump the queue ahead of other tutor
// instructions that arrive later while it's still closed. Root cause:
// onSkipStep() pushed its response straight into the nlux conversation
// (_pushAssistantMessageToNlux) regardless of whether the sidebar was open,
// while normal tutor_push progression messages go through
// _queueTutorMessage/_flushPendingTutorMessages when the sidebar is closed.
// If the skip response resolved slower than a subsequent tutor_push (a
// realistic race, since skip is a full chat() round trip), it still landed
// in the DOM immediately, ahead of the later-arriving-but-earlier-queued
// messages once the sidebar was reopened.
test("skip response from the bubble does not jump ahead of later tutor_push messages once chat reopens", async ({
  page,
}) => {
  let wsRef;

  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    wsRef = ws;
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-order-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "chat") return;

      if (message.exercise_action === "next") {
        // Simulate the skip round trip resolving slower than the
        // subsequent tutor_push messages sent below.
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "chat_response_complete",
              status: "complete",
              response: "In the Company Name field, type Northwind Trading.",
              exercise_id: "ex-crm",
              current_step: 1,
              is_optional: true,
            }),
          );
        }, 400);
        return;
      }

      if (message.exercise_action === "start") {
        ws.send(
          JSON.stringify({
            type: "chat_response_complete",
            status: "complete",
            response: "Please open the main Sales app.",
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
  await page.locator(".ai-exercise-choice-yes").click();
  await expect(
    page.getByText("Please open the main Sales app.", { exact: true }),
  ).toBeVisible();

  // Close the sidebar so we're in owl-bubble mode.
  await page.locator("#offcanvasAiSidebar .btn-close").click();

  const bubbleSkipButton = page.locator(".ai-owl-trigger-skip");
  await expect(bubbleSkipButton).toBeVisible();
  await bubbleSkipButton.click();

  // While the skip response is still in flight (400ms delay above), push
  // two "normal" progression messages that arrive first, while the sidebar
  // is still closed.
  await page.waitForTimeout(50);
  wsRef.send(
    JSON.stringify({
      type: "tutor_push",
      response: "From the top menu, go to Orders > Customers.",
      exercise_id: "ex-crm",
      timestamp: new Date().toISOString(),
    }),
  );
  await page.waitForTimeout(50);
  wsRef.send(
    JSON.stringify({
      type: "tutor_push",
      response: "Click New to create a customer.",
      exercise_id: "ex-crm",
      timestamp: new Date().toISOString(),
    }),
  );

  // Let the delayed skip response arrive too before reopening.
  await page.waitForTimeout(500);

  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

  const receivedTexts = await page
    .locator("#chat-ui-container .nlux-comp-chatItem--received .nlux-markdown-container")
    .allTextContents();

  const orderNames = ["Please open the main Sales app.", "From the top menu, go to Orders > Customers.", "Click New to create a customer.", "In the Company Name field, type Northwind Trading."];
  const positions = orderNames.map((needle) =>
    receivedTexts.findIndex((t) => t.includes(needle)),
  );

  expect(positions.every((p) => p !== -1)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});
