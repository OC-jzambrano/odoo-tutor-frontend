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
  await page.locator("#offcanvasAiSidebar .btn-close").click();
  await expect(page.locator(".ai-owl-exercise-choice-yes")).toBeVisible();
  await page.locator(".ai-owl-exercise-choice-yes").click();
  await page.locator("[data-ai-sidebar-toggle]").click();
  await expect(page.locator(".ai-exercise-choice-yes")).toBeDisabled();
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

test("skip button disappears when skipping completes the exercise", async ({
  page,
}) => {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-complete-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "chat") return;

      if (message.exercise_action === "next") {
        ws.send(
          JSON.stringify({
            type: "chat_response_complete",
            status: "exercise_completed",
            response: "Exercise completed.",
            exercise_id: "ex-crm",
            is_optional: false,
          }),
        );
        return;
      }

      ws.send(
        JSON.stringify({
          type: "chat_response_complete",
          status: "complete",
          response:
            message.exercise_action === "start"
              ? "Complete the final step."
              : "Do you want to start this exercise?",
          exercise_id: "ex-crm",
          current_step: message.exercise_action === "start" ? 0 : null,
          is_optional: message.exercise_action === "start",
        }),
      );
    });
  });

  await page.goto("/odoo?debug=assets");
  await page.locator("[data-ai-sidebar-toggle]").click();

  const composer = page.locator(
    "#chat-ui-container .nlux-comp-composer textarea",
  );
  await composer.fill("crm-create-opportunity-manual");
  await composer.press("Enter");
  await page.locator(".ai-exercise-choice-yes").click();

  const skipButton = page.locator(".ai-skip-step-button");
  await expect(skipButton).toBeVisible();
  await skipButton.click();

  await expect(page.getByText("Exercise completed.", { exact: true })).toBeVisible();
  await expect(skipButton).toHaveCount(0);
});

test("skip button still shows on a non-optional step (always visible during an active exercise, for now)", async ({
  page,
}) => {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-non-optional-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "chat") return;

      ws.send(
        JSON.stringify({
          type: "chat_response_complete",
          status: "complete",
          response:
            message.exercise_action === "start"
              ? "Click New."
              : "Do you want to start this exercise?",
          exercise_id: "ex-crm",
          current_step: message.exercise_action === "start" ? 0 : null,
          is_optional: false,
        }),
      );
    });
  });

  await page.goto("/odoo?debug=assets");
  await page.locator("[data-ai-sidebar-toggle]").click();

  const composer = page.locator(
    "#chat-ui-container .nlux-comp-composer textarea",
  );
  await composer.fill("crm-create-opportunity-manual");
  await composer.press("Enter");
  await page.locator(".ai-exercise-choice-yes").click();

  await expect(page.getByText("Click New.", { exact: true })).toBeVisible();
  await expect(page.locator(".ai-skip-step-button")).toBeVisible();
});

test("skip button and context hint never overlap when both are visible", async ({
  page,
}) => {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    ws.send(
      JSON.stringify({
        type: "connection_established",
        session_id: "playwright-skip-hint-overlap-session",
      }),
    );

    ws.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "chat") return;

      ws.send(
        JSON.stringify({
          type: "chat_response_complete",
          status: "complete",
          response:
            message.exercise_action === "start"
              ? "Click New."
              : "Do you want to start this exercise?",
          exercise_id: "ex-crm",
          current_step: message.exercise_action === "start" ? 0 : null,
          is_optional: true,
        }),
      );
    });
  });

  await page.goto("/odoo?debug=assets");
  await page.locator("[data-ai-sidebar-toggle]").click();

  const composer = page.locator(
    "#chat-ui-container .nlux-comp-composer textarea",
  );
  await composer.fill("crm-create-opportunity-manual");
  await composer.press("Enter");
  await page.locator(".ai-exercise-choice-yes").click();

  const skipButton = page.locator(".ai-skip-step-button");
  await expect(skipButton).toBeVisible();

  await page.evaluate(() =>
    window.aiTutorDebug.showHint(
      "This is a fairly long tutor hint to make sure the bubble takes up meaningful vertical space in the panel.",
    ),
  );

  const hint = page.locator(".ai-inline-hint");
  await expect(hint).toBeVisible();
  await expect(skipButton).toBeVisible();
  await expect(page.locator(".ai-inline-hint-container")).toHaveClass(
    /ai-inline-hint-container-raised/,
  );

  const [hintBox, skipBox] = await Promise.all([
    hint.boundingBox(),
    skipButton.boundingBox(),
  ]);
  expect(hintBox).not.toBeNull();
  expect(skipBox).not.toBeNull();

  const overlaps =
    skipBox.x < hintBox.x + hintBox.width &&
    skipBox.x + skipBox.width > hintBox.x &&
    skipBox.y < hintBox.y + hintBox.height &&
    skipBox.y + skipBox.height > hintBox.y;

  expect(overlaps).toBe(false);
});
