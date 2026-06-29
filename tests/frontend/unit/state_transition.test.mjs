import { describe, expect, it } from "vitest";
import {
  buildModalOpenedTransition,
  buildRecordOpenedTransition,
  buildRecordOpenedTransitionFromLiveContext,
  buildRouteChangedTransition,
  buildViewChangedTransition,
  recordNameFromRoute,
} from "../../../odoo_tutor/static/src/core/state_transition.js";

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

  it("extracts the opened record name from an Odoo breadcrumb route", () => {
    expect(recordNameFromRoute("Projects / S00138 - Hourly package")).toBe(
      "S00138 - Hourly package"
    );
    expect(recordNameFromRoute("Projects")).toBeNull();
  });

  it("builds record_opened from live_context when the route points to a record", () => {
    const transition = buildRecordOpenedTransitionFromLiveContext({
      from: { model: "project.task", view_type: "kanban" },
      context_model: "project.task",
      route: "Projects / S00138 - Hourly package",
    });

    expect(transition).toEqual({
      type: "state_transition",
      name: "record_opened",
      from: {
        model: "project.task",
        view_type: "kanban",
      },
      to: {
        model: "project.task",
        view_type: "form",
        res_id: null,
        record_name: "S00138 - Hourly package",
        res_id_present: false,
      },
    });
  });

  it("does not build record_opened from live_context for collection routes", () => {
    const transition = buildRecordOpenedTransitionFromLiveContext({
      from: { model: "project.task", view_type: "kanban" },
      context_model: "project.task",
      route: "Projects",
    });

    expect(transition).toBeNull();
  });

  it("uses the preceding card click to preserve res_id and source view", () => {
    const transition = buildRecordOpenedTransitionFromLiveContext({
      from: { model: "crm.lead", view_type: "kanban" },
      context_model: "crm.lead",
      route: "Pipeline / Mauricio Hache",
      pending_record: {
        model: "crm.lead",
        view_type: "kanban",
        res_id: 247,
        record_name: "Mauricio Hache",
      },
    });

    expect(transition.from.view_type).toBe("kanban");
    expect(transition.to.res_id).toBe(247);
    expect(transition.to.record_name).toBe("Mauricio Hache");
    expect(transition.to.res_id_present).toBe(true);
  });

  it("does not treat the Odoo home menu as an opened business record", () => {
    const transition = buildRecordOpenedTransitionFromLiveContext({
      from: { model: "crm.lead", view_type: "form" },
      context_model: "ir.ui.menu",
      route: "Ir / Ui / Menu",
    });

    expect(transition).toBeNull();
  });

  it("prefers the persistent form id over a transient card id", () => {
    const transition = buildRecordOpenedTransitionFromLiveContext({
      from: { model: "crm.lead", view_type: "kanban" },
      context_model: "crm.lead",
      route: "Pipeline / Devis pour 150 tapis",
      res_id: 31,
      pending_record: {
        model: "crm.lead",
        view_type: "kanban",
        res_id: null,
        record_name: "Devis pour 150 tapis $ 40,000.00",
      },
    });

    expect(transition.to.res_id).toBe(31);
    expect(transition.to.record_name).toBe("Devis pour 150 tapis");
    expect(transition.to.res_id_present).toBe(true);
  });

  it("does not treat settings as an opened persistent record", () => {
    expect(
      buildRecordOpenedTransitionFromLiveContext({
        from: { model: "ir.ui.menu", view_type: "home_menu" },
        context_model: "res.config.settings",
        route: "Settings / General Settings",
        res_id: 0,
      })
    ).toBeNull();
  });

  it("builds view_changed only when the active view changes", () => {
    expect(
      buildViewChangedTransition({
        from: { model: "crm.lead", view_type: "kanban" },
        to: { model: "crm.lead", view_type: "form" },
      })
    ).toEqual({
      type: "view_changed",
      name: "view_changed",
      from: { model: "crm.lead", view_type: "kanban" },
      to: { model: "crm.lead", view_type: "form" },
    });
    expect(
      buildViewChangedTransition({
        from: { view_type: "kanban" },
        to: { view_type: "kanban" },
      })
    ).toBeNull();
  });

  it("builds route_changed deterministically", () => {
    expect(
      buildRouteChangedTransition({
        from_route: "CRM / Pipeline",
        to_route: "CRM / Test Opportunity",
        state: { model: "crm.lead", view_type: "form", res_id: 123 },
      })
    ).toEqual({
      type: "route_changed",
      name: "route_changed",
      from: { route: "CRM / Pipeline" },
      to: {
        route: "CRM / Test Opportunity",
        model: "crm.lead",
        view_type: "form",
        res_id: 123,
      },
    });
  });

  it("classifies target-new model actions as wizard modals", () => {
    expect(
      buildModalOpenedTransition({
        action: {
          target: "new",
          res_model: "sale.advance.payment.inv",
          name: "Create invoices",
        },
        from: { model: "sale.order", view_type: "form" },
      })
    ).toEqual({
      type: "modal_opened",
      name: "modal_opened",
      from: { model: "sale.order", view_type: "form" },
      to: {
        model: "sale.advance.payment.inv",
        view_type: "modal",
        res_id: null,
        res_id_present: false,
      },
      modal_kind: "wizard",
      title: "Create invoices",
    });
  });

  it("ignores non-modal actions", () => {
    expect(
      buildModalOpenedTransition({
        action: { target: "current", res_model: "crm.lead" },
      })
    ).toBeNull();
  });
});
