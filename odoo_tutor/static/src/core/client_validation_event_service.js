/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { buildClientValidationEvent } from "./client_validation_event";

const INVALID_SELECTOR =
  ".o_form_view :invalid, .o_form_view .o_field_invalid, .o_form_view .o_invalid_field";
const SAVE_SELECTOR =
  ".o_form_button_save, button[name='save'], button[data-hotkey='s']";

export const clientValidationEventService = {
  dependencies: ["ai_ws", "context_service"],

  start(_env, { ai_ws: aiWs, context_service: contextService }) {
    let timer = null;
    let lastFingerprint = null;
    let lastSentAt = 0;

    const emitInvalidFields = () => {
      timer = null;
      const elements = Array.from(document.querySelectorAll(INVALID_SELECTOR));
      const event = buildClientValidationEvent({
        elements,
        context: contextService?.getContext?.() || {},
      });
      if (!event) return;

      const fingerprint = JSON.stringify({
        model: event.model,
        res_id: event.res_id,
        invalid_fields: event.invalid_fields,
      });
      const now = Date.now();
      if (fingerprint === lastFingerprint && now - lastSentAt < 750) return;
      lastFingerprint = fingerprint;
      lastSentAt = now;

      aiWs?.sendEvent?.({
        type: "ui_event",
        event_name: event.name,
        event_data: event,
      });
    };

    const scheduleScan = (delay = 0) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(emitInvalidFields, delay);
    };

    document.addEventListener("invalid", () => scheduleScan(0), true);
    document.addEventListener(
      "click",
      (event) => {
        if (event.target?.closest?.(SAVE_SELECTOR)) {
          scheduleScan(100);
        }
      },
      true
    );

    return {};
  },
};

registry
  .category("services")
  .add("client_validation_events", clientValidationEventService);
