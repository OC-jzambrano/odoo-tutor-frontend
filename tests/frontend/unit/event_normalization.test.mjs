import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalEventEnvelopeType,
  canonicalEventFingerprint,
  canonicalEventType,
  canonicalizeEvent,
} from "../../../odoo_tutor/static/src/core/event_types.js";
import { normalizeDomEvent } from "../../../odoo_tutor/static/src/core/normalize_event.js";

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
    expect(event.label).toBe("menu.crm.crm_menu_root");
    expect(event.field).toBe("menu.crm.crm_menu_root");
    expect(event.meta.view_type).toBe("home_menu");
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
});
