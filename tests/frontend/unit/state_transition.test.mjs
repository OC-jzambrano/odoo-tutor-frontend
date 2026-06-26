import { describe, expect, it } from "vitest";
import { buildRecordOpenedTransition } from "../../../odoo_tutor/static/src/core/state_transition.js";

describe("state transition contract", () => {
  it("builds record_opened when navigation lands on a form record", () => {
    const transition = buildRecordOpenedTransition({
      from: { model: "crm.lead", view_type: "kanban" },
      to: { model: "crm.lead", view_type: "form", resId: 123 },
    });

    expect(transition).toEqual({
      type: "state_transition",
      name: "record_opened",
      from: {
        model: "crm.lead",
        view_type: "kanban",
      },
      to: {
        model: "crm.lead",
        view_type: "form",
        res_id: 123,
        record_name: null,
        res_id_present: true,
      },
    });
  });

  it("does not build record_opened when the target is not a form", () => {
    const transition = buildRecordOpenedTransition({
      from: { model: "crm.lead", view_type: "kanban" },
      to: { model: "crm.lead", view_type: "list" },
    });

    expect(transition).toBeNull();
  });

  it("builds record_opened with a record name when the record id is not exposed", () => {
    const transition = buildRecordOpenedTransition({
      from: { model: "crm.lead", view_type: "kanban" },
      to: { model: "crm.lead", view_type: "form", record_name: "AM Ball's opportunity" },
    });

    expect(transition.to).toEqual({
      model: "crm.lead",
      view_type: "form",
      res_id: null,
      record_name: "AM Ball's opportunity",
      res_id_present: false,
    });
  });

  it("does not build record_opened without a record id or record name", () => {
    const transition = buildRecordOpenedTransition({
      from: { model: "crm.lead", view_type: "kanban" },
      to: { model: "crm.lead", view_type: "form" },
    });

    expect(transition).toBeNull();
  });

  it("does not build a transition for the same already-open record", () => {
    const transition = buildRecordOpenedTransition({
      from: { model: "crm.lead", view_type: "form", res_id: 123 },
      to: { model: "crm.lead", view_type: "form", resId: 123 },
    });

    expect(transition).toBeNull();
  });
});
