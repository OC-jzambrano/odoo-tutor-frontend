import { describe, expect, it } from "vitest";
import {
  buildTargetHintCaption,
  extractTargetHint,
  REINFORCE_AUTO_HINT_THRESHOLD,
  resolveTargetElement,
  shouldAutoShowTargetHint,
} from "../../../odoo_mentor/static/src/core/target_hint_resolver.js";

function makeEl({ attrs = {}, text = "", rect = { width: 120, height: 32 }, children = {} } = {}) {
  return {
    textContent: text,
    getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => rect,
    querySelectorAll: (sel) => children[sel] || [],
  };
}

describe("target_hint_resolver", () => {
  it("extracts normalized target descriptors from backend payloads", () => {
    expect(
      extractTargetHint({
        type: "tutor_hint",
        target: { kind: "field", field: "group_warning_purchase", label: "Warnings" },
      }),
    ).toEqual({
      kind: "field",
      field: "group_warning_purchase",
      name: null,
      xmlid: null,
      label: "Warnings",
      selector: null,
      actionLabel: null,
    });

    expect(
      extractTargetHint({
        type: "reinforce_push",
        target: {
          kind: "button",
          name: "execute",
          label: "Save",
          action_label: "Click Save",
        },
      }),
    ).toEqual({
      kind: "button",
      field: null,
      name: "execute",
      xmlid: null,
      label: "Save",
      selector: null,
      actionLabel: "Click Save",
    });

    expect(extractTargetHint({ type: "tutor_hint", message: "No target" })).toBeNull();
  });

  it("triggers auto-spotlight only after 3 reinforce_push calls", () => {
    expect(REINFORCE_AUTO_HINT_THRESHOLD).toBe(3);
    expect(shouldAutoShowTargetHint({ reinforceCount: 0 })).toBe(false);
    expect(shouldAutoShowTargetHint({ reinforceCount: 1 })).toBe(false);
    expect(shouldAutoShowTargetHint({ reinforceCount: 2 })).toBe(false);
    expect(shouldAutoShowTargetHint({ reinforceCount: 3 })).toBe(true);
    expect(shouldAutoShowTargetHint({ reinforceCount: 5 })).toBe(true);
  });

  it("builds concise captions for target pointer bubbles", () => {
    expect(
      buildTargetHintCaption({
        kind: "button",
        name: "execute",
        label: "Save",
        actionLabel: "Click Save",
      }),
    ).toBe("Click Save");
    expect(buildTargetHintCaption({ kind: "field", field: "purchase_line_warn_msg", label: "Warning on Purchase Orders" })).toBe(
      "Warning on Purchase Orders",
    );
    expect(buildTargetHintCaption({ kind: "button", name: "execute" })).toBe("Click here");
    expect(buildTargetHintCaption({ kind: "tab", name: "purchase" })).toBe("Open this tab");
  });

  it("resolves visible field inputs, tabs, buttons, and menus", () => {
    const checkbox = makeEl({ attrs: { type: "checkbox" }, rect: { width: 16, height: 16 } });
    const fieldWrapper = makeEl({
      children: { "input:not([type='hidden'])": [checkbox] },
    });
    const tabEl = makeEl({ text: "Purchase" });
    const saveBtn = makeEl({ text: "Save" });
    const createBtn = makeEl({ text: "New" });
    const menuEl = makeEl({ text: "Products" });

    const fakeDoc = {
      querySelectorAll: (sel) => {
        if (sel === '[data-odoo-field="group_warning_purchase"]') return [fieldWrapper];
        if (sel === '.o_notebook_headers [name="purchase"]') return [tabEl];
        if (sel === "button.o_form_button_save") return [saveBtn];
        if (sel === "button.o_list_button_add") return [createBtn];
        if (sel === '[data-menu-xmlid="purchase.menu_purchase_products"]') return [menuEl];
        return [];
      },
    };

    expect(resolveTargetElement({ kind: "field", field: "group_warning_purchase" }, fakeDoc)).toBe(checkbox);
    expect(resolveTargetElement({ kind: "tab", name: "purchase" }, fakeDoc)).toBe(tabEl);
    expect(resolveTargetElement({ kind: "button", name: "form.save" }, fakeDoc)).toBe(saveBtn);
    expect(resolveTargetElement({ kind: "button", name: "save" }, fakeDoc)).toBe(saveBtn);
    expect(resolveTargetElement({ kind: "button", name: "create" }, fakeDoc)).toBe(createBtn);
    expect(resolveTargetElement({ kind: "menu", xmlid: "purchase.menu_purchase_products" }, fakeDoc)).toBe(menuEl);
  });
});
