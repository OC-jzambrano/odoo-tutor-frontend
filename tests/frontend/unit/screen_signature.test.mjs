import { describe, expect, it } from "vitest";
import {
  cleanXmlId,
  extractActionXmlId,
  extractScreenSignatureFromRuntime,
  normalizeTargetScreen,
  resolveMenuXmlId,
  screenSignaturesEqual,
} from "../../../odoo_mentor/static/src/core/screen_signature.js";
import { buildViewChangedTransition } from "../../../odoo_mentor/static/src/core/state_transition.js";
import {
  buildDraftStepFromEvent,
  buildPolishDraftPayload,
  buildRecordingDraftPayload,
  hydrateDraftForEditing,
  isNavigationDraftStep,
  sanitizePersistedRecordingSession,
} from "../../../odoo_mentor/static/src/core/recording_draft.js";

describe("screen signature extraction and normalization", () => {
  it("ignores numeric IDs for xml_id fields", () => {
    expect(cleanXmlId("account.action_move_out_invoice_type")).toBe(
      "account.action_move_out_invoice_type"
    );
    expect(cleanXmlId(42)).toBeNull();
    expect(cleanXmlId("42")).toBeNull();
    expect(extractActionXmlId({ id: 99, xml_id: "purchase.purchase_rfq" })).toBe(
      "purchase.purchase_rfq"
    );
    expect(extractActionXmlId({ id: 99, xml_id: "99" })).toBeNull();
  });

  it("resolves menu_xml_id from explicit menu_id or matching actionID", () => {
    const menus = [
      { id: 10, xmlid: "account.menu_action_move_out_invoice_type", actionID: 201, appID: 5 },
      { id: 11, xmlid: "account.menu_action_move_in_invoice_type", actionID: 202, appID: 5 },
      { id: 12, xmlid: "other.duplicate_action_menu", actionID: 201, appID: 9 },
    ];
    const menuService = {
      getMenu: (id) => menus.find((m) => m.id === id) || null,
      getAll: () => menus,
      getCurrentApp: () => ({ id: 5, xmlid: "account.menu_finance" }),
    };

    expect(
      resolveMenuXmlId({
        menuService,
        action: { id: 201, context: { menu_id: 11 } },
      })
    ).toBe("account.menu_action_move_in_invoice_type");

    expect(
      resolveMenuXmlId({
        menuService,
        action: { id: 201 },
        hash: "",
      })
    ).toBe("account.menu_action_move_out_invoice_type");

    expect(
      resolveMenuXmlId({
        menuService,
        action: { id: 202 },
        hash: "",
      })
    ).toBe("account.menu_action_move_in_invoice_type");

    const purchaseMenus = [
      { id: 310, xmlid: "purchase.menu_purchase_root", actionID: 538, appID: 310, children: [311] },
      { id: 321, xmlid: "purchase.menu_purchase_rfq", actionID: 538, appID: 310, children: [] },
    ];
    expect(
      resolveMenuXmlId({
        menuService: {
          getAll: () => purchaseMenus,
          getCurrentApp: () => ({ id: 310 }),
        },
        action: { id: 538 },
        hash: "",
      })
    ).toBe("purchase.menu_purchase_rfq");
  });

  it("disambiguates shared-model screens (Invoices vs Bills) in view_changed", () => {
    const invoices = {
      model: "account.move",
      view_type: "list",
      action_xml_id: "account.action_move_out_invoice_type",
      menu_xml_id: "account.menu_action_move_out_invoice_type",
    };
    const bills = {
      model: "account.move",
      view_type: "list",
      action_xml_id: "account.action_move_in_invoice_type",
      menu_xml_id: "account.menu_action_move_in_invoice_type",
    };

    expect(buildViewChangedTransition({ from: invoices, to: bills })).toEqual({
      type: "view_changed",
      name: "view_changed",
      from: invoices,
      to: bills,
    });

    expect(buildViewChangedTransition({ from: invoices, to: invoices })).toBeNull();
  });

  it("extracts full screen signature from runtime controller and menuService", () => {
    const sig = extractScreenSignatureFromRuntime({
      controller: {
        props: { resModel: "crm.lead", viewType: "kanban" },
        action: { id: 301, xml_id: "crm.crm_lead_action_pipeline", res_model: "crm.lead" },
      },
      menuService: {
        getAll: () => [{ id: 20, xmlid: "crm.menu_crm_opportunities", actionID: 301, appID: 3 }],
        getCurrentApp: () => ({ id: 3 }),
      },
      hash: "",
    });

    expect(sig).toEqual({
      model: "crm.lead",
      view_type: "kanban",
      action_xml_id: "crm.crm_lead_action_pipeline",
      menu_xml_id: "crm.menu_crm_opportunities",
    });
    expect(screenSignaturesEqual(sig, normalizeTargetScreen(sig))).toBe(true);
  });
});

describe("recorded navigation steps target_screen lifecycle", () => {
  it("attaches target.target_screen on menu_clicked and breadcrumb_back steps only", () => {
    const menuStep = buildDraftStepFromEvent(
      {
        type: "menu_clicked",
        label: "Requests for Quotation",
        meta: {
          model: "purchase.order",
          target_name: "menu.purchase.menu_purchase_rfq",
        },
      },
      {
        id: "step-nav-1",
        targetScreen: {
          model: "purchase.order",
          view_type: "list",
          action_xml_id: "purchase.purchase_rfq",
        },
      }
    );

    expect(isNavigationDraftStep(menuStep)).toBe(true);
    expect(menuStep.target.target_screen).toEqual({
      model: "purchase.order",
      view_type: "list",
      action_xml_id: "purchase.purchase_rfq",
      menu_xml_id: "purchase.menu_purchase_rfq",
    });

    const breadcrumbStep = buildDraftStepFromEvent(
      {
        type: "link_clicked",
        label: "Requests for Quotation",
        meta: {
          model: "purchase.order",
          target_name: "breadcrumb.requests-for-quotation",
          navigation_kind: "breadcrumb_back",
        },
      },
      {
        id: "step-nav-2",
        targetScreen: {
          model: "purchase.order",
          view_type: "list",
          action_xml_id: "purchase.purchase_rfq",
          menu_xml_id: "purchase.menu_purchase_rfq",
        },
      }
    );

    expect(isNavigationDraftStep(breadcrumbStep)).toBe(true);
    expect(breadcrumbStep.target.target_screen).toEqual({
      model: "purchase.order",
      view_type: "list",
      action_xml_id: "purchase.purchase_rfq",
      menu_xml_id: "purchase.menu_purchase_rfq",
    });

    const regularButtonStep = buildDraftStepFromEvent(
      {
        type: "button_clicked",
        label: "New",
        meta: {
          model: "purchase.order",
          target_name: "list.create",
        },
      },
      { id: "step-btn-1" }
    );

    expect(isNavigationDraftStep(regularButtonStep)).toBe(false);
    expect(regularButtonStep.target.target_screen).toBeUndefined();
  });

  it("preserves target.target_screen across save, polish, hydrate, and session persistence", () => {
    const targetScreen = {
      model: "account.move",
      view_type: "list",
      action_xml_id: "account.action_move_out_invoice_type",
      menu_xml_id: "account.menu_action_move_out_invoice_type",
    };
    const steps = [
      {
        id: "step-1",
        instruction: "Open Invoices",
        target: {
          action: "click",
          model: "account.move",
          field: null,
          target_key: "menu.account.menu_action_move_out_invoice_type",
          target_screen: targetScreen,
        },
        target_hint: {
          kind: "menu",
          xmlid: "account.menu_action_move_out_invoice_type",
          label: "Invoices",
        },
      },
    ];

    const savePayload = buildRecordingDraftPayload({
      recordingId: "rec-1",
      title: "Open Invoices",
      module: "account",
      steps,
    });
    expect(savePayload.steps[0].target.target_screen).toEqual(targetScreen);

    const polishPayload = buildPolishDraftPayload({
      title: "Open Invoices",
      module: "account",
      steps,
    });
    expect(polishPayload.steps[0].target.target_screen).toEqual(targetScreen);

    const hydrated = hydrateDraftForEditing(savePayload);
    expect(hydrated.steps[0].target.target_screen).toEqual(targetScreen);

    const persisted = sanitizePersistedRecordingSession({
      status: "paused",
      sessionId: "sess-1",
      title: "Open Invoices",
      module: "account",
      steps,
      feed: [],
      stepIndex: 1,
      note: "",
    });
    expect(persisted.steps[0].target.target_screen).toEqual(targetScreen);
  });
});
