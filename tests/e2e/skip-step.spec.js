const { test, expect } = require("@playwright/test");

test("skip button sends a hidden forced-next action and renders the next instruction", async ({
  page,
}) => {
  const clientMessages = [];

  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      clientMessages.push(message);

      if (message.type !== "chat") return;

      if (message.exercise_action === "next") {
        ws.send(
          JSON.stringify({
            type: "chat_response_complete",
            status: "complete",
            response: "Enter the opportunity name.",
            exercise_id: "ex-crm",
            current_step: 1,
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
        }),
      );
    });
  });

  await page.goto("/odoo");
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
  await expect(page.getByText("Click New.", { exact: true })).toBeVisible();

  const skipButton = page.locator(".ai-skip-step-button");
  await expect(skipButton).toBeVisible();
  const [composerBox, skipBox] = await Promise.all([
    composer.boundingBox(),
    skipButton.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(skipBox).not.toBeNull();
  expect(skipBox.x).toBeGreaterThanOrEqual(composerBox.x + composerBox.width);

  const userMessagesBeforeSkip = await page
    .locator(".nlux-comp-chatItem--sent")
    .count();
  await skipButton.click();

  await expect(
    page.getByText("Enter the opportunity name.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Please perform the action in Odoo to continue.")).toHaveCount(
    0,
  );
  await expect(page.locator(".nlux-comp-chatItem--sent")).toHaveCount(
    userMessagesBeforeSkip,
  );

  expect(
    clientMessages.filter(
      (message) =>
        message.type === "chat" && message.exercise_action === "next",
    ),
  ).toEqual([
    expect.objectContaining({
      message: "next",
      exercise_id: "ex-crm",
      exercise_action: "next",
      context: expect.objectContaining({
        exercise_id: "ex-crm",
        exercise_action: "next",
      }),
    }),
  ]);

  expect(
    clientMessages.some(
      (message) =>
        message.type === "ui_event" &&
        JSON.stringify(message).includes("Skip to next step"),
    ),
  ).toBe(false);
});
