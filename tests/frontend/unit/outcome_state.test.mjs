import { describe, expect, it } from "vitest";
import {
  buildOutcomeState,
  buildOutcomeStateEvent,
} from "../../../odoo_tutor/static/src/core/outcome_state.js";

function makeRoot(matches = {}) {
  return {
    querySelector(selector) {
      return matches[selector] || null;
    },
  };
}

function makeTextElement(text) {
  return {
    innerText: text,
    textContent: text,
  };
}

describe("outcome state contract", () => {
  it("builds an outcome state from context service first", () => {
    const outcome = buildOutcomeState({
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "form", resId: 123 };
        },
      },
      root: makeRoot({
        ".o_form_view": {},
        ".o_control_panel_breadcrumbs .o_last_breadcrumb_item": makeTextElement(
          "Test Opportunity"
        ),
      }),
      location: { hash: "#model=res.partner&id=999&view_type=kanban" },
    });

    expect(outcome).toEqual({
      model: "crm.lead",
      view_type: "form",
      record_name: "Test Opportunity",
      res_id: 123,
      res_id_present: true,
    });
  });

  it("falls back to hash params when context is not ready", () => {
    const outcome = buildOutcomeState({
      root: makeRoot({
        ".o_form_view": {},
        ".o_navbar_breadcrumbs .o_last_breadcrumb_item": makeTextElement("Agrolait"),
      }),
      location: { hash: "#model=res.partner&id=42&view_type=form" },
    });

    expect(outcome.model).toBe("res.partner");
    expect(outcome.view_type).toBe("form");
    expect(outcome.record_name).toBe("Agrolait");
    expect(outcome.res_id).toBe(42);
    expect(outcome.res_id_present).toBe(true);
  });

  it("marks res_id_present false when no record id is available", () => {
    const outcome = buildOutcomeState({
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "kanban" };
        },
      },
      root: makeRoot({
        ".o_kanban_view": {},
      }),
      location: { hash: "#model=crm.lead&view_type=kanban" },
    });

    expect(outcome).toEqual({
      model: "crm.lead",
      view_type: "kanban",
      record_name: null,
      res_id: null,
      res_id_present: false,
    });
  });

  it("wraps the state in an outcome_state event", () => {
    const event = buildOutcomeStateEvent({
      root: makeRoot({
        ".o_form_view": {},
      }),
      location: { hash: "#model=crm.lead&id=7&view_type=form" },
    });

    expect(event.type).toBe("outcome_state");
    expect(event.outcome_state.model).toBe("crm.lead");
    expect(event.outcome_state.res_id_present).toBe(true);
  });

  it("keeps working when the context service fails", () => {
    const outcome = buildOutcomeState({
      contextService: {
        getContext() {
          throw new Error("not ready");
        },
      },
      root: makeRoot({
        ".o_list_view, .o_list_renderer": {},
      }),
      location: { hash: "#model=sale.order" },
    });

    expect(outcome.model).toBe("sale.order");
    expect(outcome.view_type).toBe("list");
    expect(outcome.record_name).toBeNull();
    expect(outcome.res_id_present).toBe(false);
  });

  it("preserves non-numeric record ids from the hash", () => {
    const outcome = buildOutcomeState({
      root: makeRoot({
        ".o_kanban_view": {},
      }),
      location: { hash: "#res_model=x.model&res_id=virtual_5" },
    });

    expect(outcome.model).toBe("x.model");
    expect(outcome.view_type).toBe("kanban");
    expect(outcome.res_id).toBe("virtual_5");
    expect(outcome.res_id_present).toBe(true);
  });

  it("uses event metadata as a fallback for res_id when context is missing it", () => {
    const outcome = buildOutcomeState({
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "form", resId: null };
        },
      },
      eventData: {
        meta: {
          model: "crm.lead",
          viewType: "form",
          resId: 243,
        },
      },
      root: makeRoot({
        ".o_form_view": {},
        ".o_control_panel_breadcrumbs .o_last_breadcrumb_item": makeTextElement(
          "Evelin Galindo"
        ),
      }),
      location: { hash: "" },
    });

    expect(outcome).toEqual({
      model: "crm.lead",
      view_type: "form",
      record_name: "Evelin Galindo",
      res_id: 243,
      res_id_present: true,
    });
  });

  it("rejects zero and transient datapoints as persistent record ids", () => {
    const zeroOutcome = buildOutcomeState({
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "form", resId: 0 };
        },
      },
      root: makeRoot({ ".o_form_view": {} }),
      location: { hash: "" },
    });
    const transientOutcome = buildOutcomeState({
      eventData: {
        meta: { model: "crm.lead", view_type: "kanban", res_id: "datapoint_8" },
      },
      root: makeRoot({ ".o_kanban_view": {} }),
      location: { hash: "" },
    });

    expect(zeroOutcome.res_id).toBeNull();
    expect(zeroOutcome.res_id_present).toBe(false);
    expect(transientOutcome.res_id).toBeNull();
    expect(transientOutcome.res_id_present).toBe(false);
  });
});
