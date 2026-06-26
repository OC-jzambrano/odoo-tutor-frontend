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
      viewType: "kanban",
      resId: 456,
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
    expect(event.meta.resId).toBe(243);
  });
});
