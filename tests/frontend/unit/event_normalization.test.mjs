import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalEventEnvelopeType,
  canonicalEventFingerprint,
  canonicalEventType,
  canonicalizeEvent,
} from "../../../odoo_mentor/static/src/core/event_types.js";
import { normalizeDomEvent } from "../../../odoo_mentor/static/src/core/normalize_event.js";

function installBrowserStubs() {
  globalThis.CSS = {
    escape(value) {
      return String(value);
    },
  };
  globalThis.window = {
    location: {
      hash: "#model=crm.lead&id=123&view_type=kanban",
    },
  };
  globalThis.document = {
    body: {},
    querySelector(selector) {
      if (selector === ".o_kanban_view") {
        return {};
      }
      return null;
    },
  };
}

function makeElement({
  tagName,
  text = "",
  id = "",
  className = "",
  attrs = {},
  dataset = {},
  parentElement = null,
  previousElementSibling = null,
  closestMap = {},
}) {
  const element = {
    tagName,
    nodeName: tagName,
    nodeType: 1,
    id,
    className,
    dataset,
    parentElement,
    previousElementSibling,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === "id") {
        return id;
      }
      if (name === "class") {
        return className;
      }
      return attrs[name] ?? null;
    },
    closest(selector) {
      for (const [key, value] of Object.entries(closestMap)) {
        if (selector.includes(key)) {
          return value;
        }
      }
      const selectors = selector.split(",").map((part) => part.trim());
      if (selectors.some((part) => part === "button") && tagName === "BUTTON") {
        return element;
      }
      if (selectors.some((part) => part === "a") && tagName === "A") {
        return element;
      }
      if (selector.includes("[data-name]") && dataset.name) {
        return element;
      }
      return null;
    },
    querySelector(selector) {
      return closestMap[`query:${selector}`] || null;
    },
  };
  return element;
}

describe("event type normalization", () => {
  it("uses ui_event as the envelope for current and legacy event sources", () => {
    expect(canonicalEventEnvelopeType("recorder_event")).toBe("ui_event");
    expect(canonicalEventEnvelopeType("state_transition_event")).toBe("ui_event");
    expect(canonicalEventEnvelopeType("ui_event")).toBe("ui_event");
    expect(canonicalEventEnvelopeType("feedback_event")).toBe("feedback_event");
  });

  it("maps legacy button/link names to canonical names", () => {
    expect(canonicalEventType("button_click")).toBe("button_clicked");
    expect(canonicalEventType("link_click")).toBe("link_clicked");
  });

  it("normalizes wizard_opened to the canonical modal contract", () => {
    expect(canonicalEventType("wizard_opened")).toBe("modal_opened");
    expect(canonicalizeEvent({ type: "wizard_opened", title: "Create invoice" })).toEqual({
      type: "modal_opened",
      title: "Create invoice",
      modal_kind: "wizard",
    });
  });

  it("keeps already-canonical and unknown names stable", () => {
    expect(canonicalEventType("button_clicked")).toBe("button_clicked");
    expect(canonicalEventType("field_changed")).toBe("field_changed");
    expect(canonicalEventType("custom_event")).toBe("custom_event");
  });

  it("canonicalizes a copy without mutating the original event", () => {
    const original = { type: "button_click", label: "Save" };
    const normalized = canonicalizeEvent(original);

    expect(original).toEqual({ type: "button_click", label: "Save" });
    expect(normalized).toEqual({ type: "button_clicked", label: "Save" });
    expect(normalized).not.toBe(original);
  });

  it("normalizes legacy metadata aliases to one canonical shape", () => {
    expect(
      canonicalizeEvent({
        type: "card_clicked",
        meta: { model: "crm.lead", viewType: "kanban", resId: 247 },
      })
    ).toEqual({
      type: "card_clicked",
      meta: {
        model: "crm.lead",
        view_type: "kanban",
        res_id: 247,
        row_res_id: null,
        card_res_id: null,
        target_name: null,
      },
    });
  });

  it("gives legacy and canonical payloads the same idempotency fingerprint", () => {
    const legacy = {
      type: "link_click",
      label: "CRM",
      meta: { model: "ir.ui.menu", viewType: "home_menu", resId: null },
      ts: "2026-06-29T01:00:00.000Z",
    };
    const canonical = {
      type: "link_clicked",
      label: "CRM",
      meta: {
        model: "ir.ui.menu",
        view_type: "home_menu",
        res_id: null,
        row_res_id: null,
        card_res_id: null,
        target_name: null,
      },
      ts: "2026-06-29T01:00:01.000Z",
    };

    expect(canonicalEventFingerprint(legacy)).toBe(
      canonicalEventFingerprint(canonical)
    );
  });
});

describe("DOM event normalization", () => {
  beforeEach(() => {
    installBrowserStubs();
  });

  it("uses stable OWL field metadata before DOM heuristics", () => {
    const owlField = makeElement({
      tagName: "DIV",
      attrs: {
        "data-odoo-field": "name",
        "data-odoo-field-label": "Opportunity",
        "data-odoo-model": "crm.lead",
      },
    });
    const target = makeElement({
      tagName: "INPUT",
      id: "name_0",
      className: "o_input",
      closestMap: {
        "[data-odoo-field]": owlField,
      },
    });
    target.value = "Atomic CRM Opportunity";

    const event = normalizeDomEvent({
      domEventType: "change",
      originalEvent: { target },
      context: { model: "stale.model", viewType: "form" },
    });

    expect(event.type).toBe("field_changed");
    expect(event.field).toBe("name");
    expect(event.label).toBe("Opportunity");
    expect(event.value).toBe("Atomic CRM Opportunity");
    expect(event.meta.model).toBe("crm.lead");
    expect(event.meta.target_name).toBe("name");
    expect(event.quality.level).toBe("strong");
    expect(event.quality.sources.field).toBe("owl_props");
  });

  it("emits button_clicked for real button clicks", () => {
    const target = makeElement({
      tagName: "BUTTON",
      text: "Save",
      className: "btn btn-primary",
      attrs: { name: "action_save" },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "form", resId: 123 };
        },
      },
    });

    expect(event.type).toBe("button_clicked");
    expect(event.label).toBe("action_save");
    expect(event.meta.model).toBe("crm.lead");
    expect(event.meta.view_type).toBe("form");
    expect(event.meta.res_id).toBe(123);
  });

  it("emits link_clicked for anchor clicks", () => {
    const target = makeElement({
      tagName: "A",
      text: "Open customer",
      attrs: { href: "#id=123&model=res.partner" },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      contextService: {
        getContext() {
          return { model: "res.partner", view_type: "kanban" };
        },
      },
    });

    expect(event.type).toBe("link_clicked");
    expect(event.label).toBe("Open customer");
    expect(event.meta.kind).toBe("link");
  });

  it("emits card_clicked for kanban record clicks", () => {
    const kanbanRecord = makeElement({
      tagName: "DIV",
      text: "Test Opportunity",
      className: "o_kanban_record",
      attrs: { "data-res-id": "456" },
    });
    const target = makeElement({
      tagName: "DIV",
      text: "Test Opportunity",
      closestMap: {
        ".o_kanban_record": kanbanRecord,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "kanban" };
        },
      },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.label).toBe("Test Opportunity");
    expect(event.meta.model).toBe("crm.lead");
    expect(event.meta.view_type).toBe("kanban");
    expect(event.meta.res_id).toBe(456);
    expect(event.meta.card_res_id).toBe(456);
  });

  it("keeps kanban card anchors as card_clicked", () => {
    const kanbanRecord = makeElement({
      tagName: "DIV",
      text: "Mauricio Hache",
      className: "o_kanban_record",
      attrs: { "data-res-id": "247" },
    });
    const target = makeElement({
      tagName: "A",
      text: "Mauricio Hache",
      attrs: { href: "/odoo/crm/247" },
      closestMap: {
        ".o_kanban_record": kanbanRecord,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      contextService: {
        getContext() {
          return { model: "crm.lead", view_type: "kanban" };
        },
      },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.label).toBe("Mauricio Hache");
    expect(event.meta.res_id).toBe(247);
    expect(event.meta.card_res_id).toBe(247);
  });

  it("uses kanban ancestry over stale form context", () => {
    const kanbanRecord = makeElement({
      tagName: "DIV",
      text: "Stale Context Opportunity",
      className: "o_kanban_record",
      attrs: { "data-res-id": "99" },
    });
    const target = makeElement({
      tagName: "A",
      text: "Stale Context Opportunity",
      closestMap: {
        ".o_kanban_record": kanbanRecord,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: {
        model: "crm.lead",
        viewType: "form",
        resId: 31,
      },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.meta.view_type).toBe("kanban");
    expect(event.meta.res_id).toBe(99);
  });

  it("keeps secondary buttons inside kanban cards as button_clicked", () => {
    const kanbanRecord = makeElement({
      tagName: "DIV",
      text: "Opportunity",
      className: "o_kanban_record",
      attrs: { "data-res-id": "99" },
    });
    kanbanRecord.contains = () => true;
    const target = makeElement({
      tagName: "BUTTON",
      text: "Archive",
      attrs: { name: "action_archive" },
      closestMap: {
        ".o_kanban_record": kanbanRecord,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "crm.lead", viewType: "kanban" },
    });

    expect(event.type).toBe("button_clicked");
    expect(event.meta.res_id).toBe(99);
  });

  it("separates transient Odoo datapoints from persistent record ids", () => {
    const kanbanRecord = makeElement({
      tagName: "ARTICLE",
      text: "Transient Opportunity",
      className: "o_kanban_record",
      attrs: { "data-id": "datapoint_89" },
    });
    const target = makeElement({
      tagName: "SPAN",
      text: "Transient Opportunity",
      closestMap: {
        ".o_kanban_record": kanbanRecord,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "crm.lead", viewType: "kanban" },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.meta.res_id).toBeNull();
    expect(event.meta.card_res_id).toBeNull();
    expect(event.meta.client_record_id).toBe("datapoint_89");
  });

  it("emits menu_clicked for Odoo app launchers", () => {
    const target = makeElement({
      tagName: "A",
      text: "CRM",
      dataset: { menuXmlid: "crm.crm_menu_root" },
      attrs: { href: "/odoo/crm" },
      closestMap: {
        ".o_app": null,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "ir.ui.menu", viewType: "home_menu" },
    });

    expect(event.type).toBe("menu_clicked");
    expect(event.label).toBe("CRM");
    expect(event.field).toBe("menu.crm.crm_menu_root");
    expect(event.meta.target_name).toBe("menu.crm.crm_menu_root");
    expect(event.meta.view_type).toBe("home_menu");
  });

  it("resolves field/value for many2one quick-create autocomplete clicks", () => {
    const target = makeElement({
      tagName: "A",
      text: 'Create "Azure interiorf"',
      id: "partner_id_1_0_0",
      className:
        "dropdown-item ui-menu-item-wrapper text-truncate ui-state-active o_m2o_dropdown_option_create",
      closestMap: {
        ".dropdown-item": null,
      },
    });
    // Simulate real DOM: the option itself matches the dropdown-item selector.
    target.closest = (selector) =>
      selector.includes("dropdown-item") || selector.includes("ui-menu-item-wrapper")
        ? target
        : selector.includes("o_m2o_dropdown_option_create")
        ? target
        : null;

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "crm.lead", view_type: "form", resId: 5 },
    });

    expect(event.type).toBe("link_clicked");
    expect(event.label).toBe('Create "Azure interiorf"');
    expect(event.field).toBe("partner_id");
    expect(event.value).toBe('Create "Azure interiorf"');
    expect(event.meta.target_name).toBe("partner_id");
    expect(event.meta.m2o_action).toBe("create");
    expect(event.quality.level).toBe("strong");
  });

  it("marks many2one autocomplete selection of an existing record as select", () => {
    const target = makeElement({
      tagName: "A",
      text: "Acme Corp",
      id: "partner_id_1_0_1",
      className: "dropdown-item ui-menu-item-wrapper",
    });
    target.closest = (selector) =>
      selector.includes("dropdown-item") || selector.includes("ui-menu-item-wrapper")
        ? target
        : null;

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "crm.lead", view_type: "form", resId: 5 },
    });

    expect(event.type).toBe("link_clicked");
    expect(event.field).toBe("partner_id");
    expect(event.value).toBe("Acme Corp");
    expect(event.meta.m2o_action).toBe("select");
  });

  it("emits tab_changed for notebook tab clicks", () => {
    const target = makeElement({
      tagName: "A",
      text: "Purchase",
      attrs: { href: "#purchase", role: "tab" },
      dataset: { pageId: "purchase" },
    });
    const baseClosest = target.closest.bind(target);
    target.closest = (selector) =>
      selector.includes("nav-link") || selector.includes("[role='tab']")
        ? target
        : baseClosest(selector);

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "res.partner", view_type: "form" },
    });

    expect(event.type).toBe("tab_changed");
    expect(event.field).toBe("purchase");
    expect(event.meta.target_name).toBe("purchase");
  });

  it("normalizes kanban and form New buttons to kanban.create and form.create", () => {
    const kanbanBtn = makeElement({
      tagName: "BUTTON",
      text: "New",
      className: "btn btn-primary o-kanban-button-new",
    });
    const kanbanEvent = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: kanbanBtn },
      context: { model: "crm.lead", view_type: "kanban" },
    });
    expect(kanbanEvent.type).toBe("button_clicked");
    expect(kanbanEvent.meta.target_name).toBe("kanban.create");
    expect(kanbanEvent.label).toBe("kanban.create");

    const formBtn = makeElement({
      tagName: "BUTTON",
      text: "New",
      className: "btn btn-outline-primary o_form_button_create",
    });
    const formEvent = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: formBtn },
      context: { model: "crm.lead", view_type: "form" },
    });
    expect(formEvent.type).toBe("button_clicked");
    expect(formEvent.meta.target_name).toBe("form.create");
    expect(formEvent.label).toBe("form.create");
  });

  it("normalizes list row checkboxes semantically, ignores ephemeral checkbox-comp IDs, and counts selected rows", () => {
    const cb1 = makeElement({
      tagName: "INPUT",
      id: "checkbox-comp-53",
      attrs: { type: "checkbox" },
    });
    cb1.checked = true;
    const cb2 = makeElement({
      tagName: "INPUT",
      id: "checkbox-comp-54",
      attrs: { type: "checkbox" },
    });
    cb2.checked = true;
    const cb3 = makeElement({
      tagName: "INPUT",
      id: "checkbox-comp-55",
      attrs: { type: "checkbox" },
    });
    cb3.checked = false;

    const table = {
      querySelectorAll: (sel) =>
        sel.includes("o_list_record_selector") ? [cb1, cb2, cb3] : [],
    };
    const td = {
      closest: (sel) => (sel.includes("table") ? table : null),
      querySelector: () => cb2,
    };
    const wrapperDiv = makeElement({
      tagName: "DIV",
      className: "o-checkbox form-check",
      closestMap: {
        "td.o_list_record_selector": td,
      },
    });
    cb2.closest = (sel) =>
      sel.includes("td.o_list_record_selector") ? td : null;

    // Clicking the input directly (already toggled to checked=true by browser)
    const inputEvt = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: cb2 },
      context: { model: "purchase.order", view_type: "list" },
    });
    expect(inputEvt.type).toBe("list_selection_changed");
    expect(inputEvt.field).toBeNull();
    expect(inputEvt.value).toBe(2);
    expect(inputEvt.meta.target_name).toBe("list.select_row");
    expect(inputEvt.meta.model).toBe("purchase.order");
    expect(inputEvt.meta.view_type).toBe("list");
    expect(inputEvt.meta.selected_count).toBe(2);
    expect(inputEvt.meta.total_rows).toBe(3);
    expect(inputEvt.dom.id).toBeNull();
    expect(inputEvt.dom.selector).toBe("td.o_list_record_selector input[type='checkbox']");

    // Clicking the wrapper div before OWL toggles cb2 from false -> true
    cb2.checked = false;
    const divEvt = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: wrapperDiv },
      context: { model: "purchase.order", view_type: "list" },
    });
    expect(divEvt.type).toBe("list_selection_changed");
    expect(divEvt.meta.target_name).toBe("list.select_row");
    expect(divEvt.meta.selected_count).toBe(2);
    expect(divEvt.meta.selection_checked).toBe(true);
  });

  it("normalizes header select-all checkbox in list view", () => {
    const cb1 = { checked: false };
    const cb2 = { checked: false };
    const headerCb = makeElement({
      tagName: "INPUT",
      id: "checkbox-comp-1",
      attrs: { type: "checkbox" },
    });
    headerCb.checked = true;
    const table = {
      querySelectorAll: () => [cb1, cb2],
    };
    const th = {
      closest: (sel) => (sel.includes("table") ? table : null),
      querySelector: () => headerCb,
    };
    headerCb.closest = (sel) =>
      sel.includes("th.o_list_record_selector") ? th : null;

    const evt = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: headerCb },
      context: { model: "purchase.order", view_type: "list" },
    });
    expect(evt.type).toBe("list_selection_changed");
    expect(evt.meta.target_name).toBe("list.select_all");
    expect(evt.meta.selected_count).toBe(2);
    expect(evt.dom.id).toBeNull();
  });

  it("normalizes desktop and mobile breadcrumb clicks with clean labels and canonical target_name", () => {
    const breadcrumbLink = makeElement({
      tagName: "A",
      text: "Requests for Quotation",
      attrs: {
        href: "/odoo/purchase",
        "data-tooltip": 'Back to "Requests for Quotation"',
        title: 'Back to "Requests for Quotation"',
      },
    });
    breadcrumbLink.closest = (sel) =>
      sel.includes("breadcrumb-item") || sel.includes("a") ? breadcrumbLink : null;

    const desktopEvt = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: breadcrumbLink },
      context: { model: "purchase.order", view_type: "form" },
    });

    expect(desktopEvt.type).toBe("link_clicked");
    expect(desktopEvt.label).toBe("Requests for Quotation");
    expect(desktopEvt.meta.target_name).toBe("breadcrumb.requests-for-quotation");
    expect(desktopEvt.meta.navigation_kind).toBe("breadcrumb_back");
    expect(desktopEvt.meta.breadcrumb_label).toBe("Requests for Quotation");

    // Mobile icon-only .o_back_button in Spanish strips tooltip prefix + quotes
    const mobileBack = makeElement({
      tagName: "BUTTON",
      text: "",
      className: "o_back_button btn",
      attrs: { title: 'Volver a "Solicitudes de presupuesto"' },
    });
    mobileBack.closest = (sel) =>
      sel.includes(".o_back_button") || sel.includes("button") ? mobileBack : null;

    const mobileEvt = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target: mobileBack },
      context: { model: "purchase.order", view_type: "form" },
    });

    expect(mobileEvt.type).toBe("link_clicked");
    expect(mobileEvt.label).toBe("Solicitudes de presupuesto");
    expect(mobileEvt.meta.target_name).toBe("breadcrumb.solicitudes-de-presupuesto");
    expect(mobileEvt.meta.navigation_kind).toBe("breadcrumb_back");
  });
});
