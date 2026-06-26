/* eslint-disable */
/** @odoo-module **/

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeId(value) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
}

function parseHashParams(hashValue) {
  const hash = String(hashValue || "").replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return {
    model: params.get("model") || params.get("res_model") || params.get("active_model") || null,
    res_id: safeId(params.get("id") || params.get("res_id")),
    view_type: params.get("view_type") || null,
  };
}

function guessViewTypeFromDom(root = document) {
  try {
    if (root.querySelector(".o_form_view")) return "form";
    if (root.querySelector(".o_kanban_view")) return "kanban";
    if (root.querySelector(".o_list_view, .o_list_renderer")) return "list";
    if (root.querySelector(".o_graph_view")) return "graph";
    if (root.querySelector(".o_pivot_view")) return "pivot";
  } catch {}
  return "unknown";
}

function getRecordNameFromDom(root = document) {
  try {
    const selectors = [
      ".o_form_view .o_field_widget[name='display_name']",
      ".o_form_view .o_field_char[name='name']",
      ".o_form_view [name='name']",
      ".o_form_sheet .o_form_label + .o_field_widget",
      ".o_control_panel_breadcrumbs .o_last_breadcrumb_item",
      ".o_navbar_breadcrumbs .o_last_breadcrumb_item",
    ];

    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element?.innerText || element?.textContent || element?.value);
      if (text) return text;
    }
  } catch {}
  return null;
}

function readContext(contextService) {
  try {
    return contextService?.getContext?.() || {};
  } catch {
    return {};
  }
}

export function buildOutcomeState({ contextService, root = document, location = window.location } = {}) {
  const context = readContext(contextService);
  const hash = parseHashParams(location?.hash);
  const model = context.model || context.currentModel || hash.model || null;
  const view_type = context.view_type || context.view || hash.view_type || guessViewTypeFromDom(root);
  const res_id = context.resId ?? context.res_id ?? hash.res_id ?? null;
  const record_name = getRecordNameFromDom(root);

  return {
    model,
    view_type,
    record_name,
    res_id,
    res_id_present: res_id != null && res_id !== "",
  };
}

export function buildOutcomeStateEvent(input = {}) {
  return {
    type: "outcome_state",
    outcome_state: buildOutcomeState(input),
  };
}
