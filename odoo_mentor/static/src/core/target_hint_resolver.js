/* eslint-disable */
/** @odoo-module **/

export const REINFORCE_AUTO_HINT_THRESHOLD = 3;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeAttr(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isVisibleElement(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Extract a normalized UI target descriptor from a backend tutor payload.
export function extractTargetHint(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw =
    payload.target ||
    payload.target_hint ||
    payload.ui_target ||
    payload.expected_target ||
    null;
  if (!raw || typeof raw !== "object") return null;

  const field = clean(raw.field || raw.field_name);
  const name = clean(raw.name || raw.button_name || raw.tab_name);
  const xmlid = clean(raw.xmlid || raw.menu_xmlid);
  const label = clean(raw.label || raw.field_label || raw.text);
  const selector = clean(raw.selector);
  const actionLabel = clean(raw.action_label || raw.hint_label);
  const kind =
    clean(raw.kind || raw.type).toLowerCase() ||
    (field ? "field" : xmlid ? "menu" : name ? "button" : selector ? "selector" : "");

  if (!kind && !field && !name && !xmlid && !label && !selector) {
    return null;
  }

  return {
    kind: kind || "field",
    field: field || null,
    name: name || null,
    xmlid: xmlid || null,
    label: label || null,
    selector: selector || null,
    actionLabel: actionLabel || null,
  };
}

// Return true once reinforce_push calls reach the auto-spotlight threshold.
export function shouldAutoShowTargetHint({ reinforceCount = 0, threshold = REINFORCE_AUTO_HINT_THRESHOLD } = {}) {
  return Number(reinforceCount) >= Number(threshold);
}

// Build a short action caption for the floating target pointer bubble.
export function buildTargetHintCaption(target) {
  if (!target) return "Look here";
  if (target.actionLabel) return target.actionLabel;
  if (target.label) return target.label;
  if (target.kind === "button") return "Click here";
  if (target.kind === "tab") return "Open this tab";
  if (target.kind === "menu") return "Open this menu";
  if (target.field) return target.field;
  return "Look here";
}

function findFirstVisible(root, selectors) {
  for (const selector of selectors) {
    if (!selector) continue;
    let matches = [];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch {
      matches = [];
    }
    const visible = matches.find(isVisibleElement);
    if (visible) return visible;
  }
  return null;
}

function findByLabel(root, selector, label) {
  const needle = clean(label).toLowerCase();
  if (!needle) return null;
  let matches = [];
  try {
    matches = Array.from(root.querySelectorAll(selector));
  } catch {
    matches = [];
  }
  const visible = matches.filter(isVisibleElement);
  return (
    visible.find((el) => clean(el.textContent || el.getAttribute?.("title")).toLowerCase() === needle) ||
    visible.find((el) => clean(el.textContent || el.getAttribute?.("title")).toLowerCase().includes(needle)) ||
    null
  );
}

// Resolve a normalized target descriptor to a visible Odoo DOM element.
export function resolveTargetElement(target, root = typeof document !== "undefined" ? document : null) {
  if (!target || !root) return null;

  if (target.kind === "field" && target.field) {
    const f = escapeAttr(target.field);
    const wrapper = findFirstVisible(root, [
      `[data-odoo-field="${f}"]`,
      `.o_field_widget[name="${f}"]`,
      `[name="${f}"]`,
    ]);
    if (wrapper) {
      const control = findFirstVisible(wrapper, [
        "input:not([type='hidden'])",
        "textarea",
        "select",
        ".form-check-input",
      ]);
      return control || wrapper;
    }
  }

  if (target.kind === "tab") {
    const tabName = target.name || target.field;
    if (tabName) {
      const n = escapeAttr(tabName);
      const tab = findFirstVisible(root, [
        `.o_notebook_headers a[name="${n}"]`,
        `.o_notebook_headers [name="${n}"]`,
        `.o_notebook_headers [data-page-id="${n}"]`,
      ]);
      if (tab) return tab;
    }
    if (target.label) {
      const tab = findByLabel(root, ".o_notebook_headers .nav-link, [role='tab']", target.label);
      if (tab) return tab;
    }
  }

  if (target.kind === "button") {
    const btnName = target.name || target.field;
    const lowered = clean(btnName).toLowerCase();
    if (lowered === "form.save" || lowered === "save") {
      const saveBtn = findFirstVisible(root, ["button.o_form_button_save", 'button[name="execute"]']);
      if (saveBtn) return saveBtn;
    } else if (
      lowered === "list.create" ||
      lowered === "form.create" ||
      lowered === "create" ||
      lowered === "new"
    ) {
      const createBtn = findFirstVisible(root, [
        "button.o_list_button_add",
        "button.o-kanban-button-new",
        "button.o_form_button_create",
      ]);
      if (createBtn) return createBtn;
    } else if (lowered === "form.discard" || lowered === "discard") {
      const discardBtn = findFirstVisible(root, ["button.o_form_button_cancel"]);
      if (discardBtn) return discardBtn;
    } else if (btnName) {
      const n = escapeAttr(btnName);
      const btn = findFirstVisible(root, [
        `button[name="${n}"]`,
        `button[data-name="${n}"]`,
        `a[name="${n}"]`,
        `[role="button"][name="${n}"]`,
      ]);
      if (btn) return btn;
    }
    if (target.label) {
      const btn = findByLabel(root, "button, [role='button'], a.btn", target.label);
      if (btn) return btn;
    }
  }

  if (target.kind === "menu") {
    if (target.xmlid) {
      const x = escapeAttr(target.xmlid);
      const menu = findFirstVisible(root, [
        `[data-menu-xmlid="${x}"]`,
        `[data-menu-xml-id="${x}"]`,
      ]);
      if (menu) return menu;
    }
    if (target.label) {
      const menu = findByLabel(
        root,
        ".o_menu_sections button, .o_menu_sections a, .o_app, [role='menuitem'], .o-dropdown-item",
        target.label
      );
      if (menu) return menu;
    }
  }

  if (target.selector) {
    const direct = findFirstVisible(root, [target.selector]);
    if (direct) return direct;
  }

  if (target.label) {
    return findByLabel(
      root,
      "[data-odoo-field-label], button, .nav-link, [role='menuitem'], label",
      target.label
    );
  }

  return null;
}
