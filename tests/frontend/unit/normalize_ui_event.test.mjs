import { describe, expect, it } from "vitest";
import { normalizeDomEvent } from "../../../odoo_tutor/static/src/core/normalize_ui_event.js";

function makeElement({
  tagName = "DIV",
  text = "",
  attrs = {},
  dataset = {},
  closestMap = {},
} = {}) {
  const element = {
    tagName,
    textContent: text,
    innerText: text,
    dataset,
    id: attrs.id || "",
    className: attrs.class || "",
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    closest(selector) {
      for (const [key, value] of Object.entries(closestMap)) {
        if (selector.includes(key)) {
          return value;
        }
      }
      return null;
    },
    querySelector() {
      return null;
    },
  };
  return element;
}

describe("UI event normalization", () => {
  it("emits card_clicked for kanban record clicks in the sidebar event path", () => {
    const record = makeElement({
      tagName: "DIV",
      text: "Dependencies Control Project",
      attrs: { "data-res-id": "456" },
      dataset: { resId: "456" },
    });
    const target = makeElement({
      tagName: "SPAN",
      text: "Dependencies Control Project",
      closestMap: {
        ".o_kanban_record": record,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "project.project", viewType: "kanban", resId: null },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.label).toBe("Dependencies Control Project");
    expect(event.field).toBe("kanban.card");
    expect(event.meta).toEqual({
      model: "project.project",
      view_type: "kanban",
      res_id: 456,
      row_res_id: null,
      kind: "other",
      target_name: null,
      card_res_id: 456,
      client_record_id: null,
    });
  });

  it("keeps kanban card anchors semantic instead of downgrading them to link_clicked", () => {
    const record = makeElement({
      tagName: "DIV",
      text: "Evelin Galindo",
      attrs: { "data-res-id": "243" },
      dataset: { resId: "243" },
    });
    const target = makeElement({
      tagName: "A",
      text: "Evelin Galindo",
      attrs: { href: "/odoo/crm/243" },
      closestMap: {
        ".o_kanban_record": record,
      },
    });

    const event = normalizeDomEvent({
      domEventType: "click",
      originalEvent: { target },
      context: { model: "crm.lead", viewType: "kanban", resId: null },
    });

    expect(event.type).toBe("card_clicked");
    expect(event.label).toBe("Evelin Galindo");
    expect(event.meta.res_id).toBe(243);
  });

  it("uses the visible option label as value for Odoo radio inputs", () => {
    const fieldWidget = makeElement({
      tagName: "DIV",
      attrs: { class: "o_field_widget" },
      dataset: { name: "type" },
    });
    const labelEl = makeElement({ tagName: "LABEL", text: "Invoice" });
    const target = makeElement({
      tagName: "INPUT",
      attrs: {
        id: "radio_field_1_invoice",
        type: "radio",
        "data-value": "invoice",
      },
      dataset: { value: "invoice" },
      closestMap: {
        ".o_field_widget[data-name]": fieldWidget,
      },
    });
    target.type = "radio";
    target.ownerDocument = {
      querySelector(selector) {
        return selector.includes("radio_field_1_invoice") ? labelEl : null;
      },
    };

    const event = normalizeDomEvent({
      domEventType: "change",
      originalEvent: { target },
      context: { model: "res.partner", viewType: "form", resId: 7 },
    });

    expect(event.type).toBe("field_changed");
    expect(event.field).toBe("type");
    expect(event.value).toBe("Invoice");
    expect(event.meta.radio_value).toBe("invoice");
  });
});
