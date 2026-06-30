const { test, expect } = require("@playwright/test");

function parseEventFrame(payload) {
  if (typeof payload !== "string") return null;
  try {
    const message = JSON.parse(payload);
    return message?.type === "ui_event" ? message : null;
  } catch {
    return null;
  }
}

test("opening a CRM kanban card emits card_clicked and record_opened", async ({
  page,
}) => {
  const sentEvents = [];
  const leadName = `Playwright card event ${Date.now()}`;

  const createResponse = await page.request.post(
    "/web/dataset/call_kw/crm.lead/create",
    {
      data: {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "crm.lead",
          method: "create",
          args: [{ name: leadName, type: "opportunity" }],
          kwargs: {},
        },
      },
    },
  );
  const createPayload = await createResponse.json();
  expect(createPayload.error, "Could not create the CRM test record").toBeUndefined();

  page.on("websocket", (webSocket) => {
    webSocket.on("framesent", ({ payload }) => {
      const event = parseEventFrame(payload);
      if (event) sentEvents.push(event);
    });
  });

  await page.goto("/odoo/crm");
  await expect(
    page.locator(".o_web_client"),
    "Odoo did not load an authenticated web client. Run `npm run test:e2e:auth` to refresh the saved login.",
  ).toBeVisible();

  const firstCard = page
    .locator(".o_kanban_record")
    .filter({ hasText: leadName })
    .first();
  await expect(
    firstCard,
    "CRM did not render a visible kanban card to open.",
  ).toBeVisible();

  await firstCard.click();
  await expect(page.locator(".o_form_view")).toBeVisible();

  await expect
    .poll(
      () => sentEvents.find((event) => event.event_name === "card_clicked"),
      { message: "No card_clicked ui_event was sent after clicking the kanban card." },
    )
    .toBeTruthy();

  await expect
    .poll(
      () => sentEvents.find((event) => event.event_name === "record_opened"),
      {
        message:
          "No record_opened ui_event was sent after the kanban card opened.",
      },
    )
    .toMatchObject({
      type: "ui_event",
      event_name: "record_opened",
      event_data: {
        to: {
          model: "crm.lead",
          view_type: "form",
          res_id_present: true,
        },
      },
    });
});
