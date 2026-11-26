/* eslint-disable */
/** @odoo-module **/

import { canonicalEventType } from "./event_types";
import {
  normalizePersistentRecordId,
  transientClientRecordId,
} from "./record_id";

function cleanText(s) {
  return (s || "").toString().trim().replace(/\s+/g, " ").slice(0, 140);
}

function slugify(s) {
  return (s || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
}

function safeCssEscape(x) {
  try { return CSS.escape(x); } catch { return x; }
}

const EPHEMERAL_OWL_ID_RE = /^checkbox-comp-\d+$/i;

function isEphemeralDomId(id) {
  return !!(id && EPHEMERAL_OWL_ID_RE.test(String(id).trim()));
}

function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let node = el;
  const body = globalThis.document?.body || null;
  while (node && node.nodeType === 1 && node !== body) {
    let sel = node.nodeName.toLowerCase();
    if (node.id && !isEphemeralDomId(node.id)) {
      sel += "#" + node.id;
      parts.unshift(sel);
      break;
    }
    const cls = (node.className || "")
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    if (cls) sel += "." + cls;

    let i = 1;
    let sib = node;
    while ((sib = sib.previousElementSibling)) {
      if (sib.nodeName === node.nodeName) i++;
    }
    sel += `:nth-of-type(${i})`;
    parts.unshift(sel);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function buildSelector(el) {
  if (!el) return null;
  if (el.id && !isEphemeralDomId(el.id)) return `#${safeCssEscape(el.id)}`;
  if (el.dataset?.name) return `[data-name="${safeCssEscape(el.dataset.name)}"]`;
  const name = el.getAttribute?.("name");
  if (name) return `${(el.tagName || "").toLowerCase()}[name="${safeCssEscape(name)}"]`;
  const tag = (el.tagName || "").toLowerCase();
  const cls = (el.className || "").toString().split(/\s+/).filter(Boolean)[0];
  if (cls) return `${tag}.${safeCssEscape(cls)}`;
  return tag || null;
}

export function detectActiveViewType(root = globalThis.document) {
  if (!root?.querySelector) return "unknown";
  if (root.querySelector(".o_kanban_view")) return "kanban";
  if (root.querySelector(".o_list_view, .o_list_renderer")) return "list";
  if (root.querySelector(".o_form_view")) return "form";
  if (root.querySelector(".o_graph_view")) return "graph";
  if (root.querySelector(".o_pivot_view")) return "pivot";
  return "unknown";
}

function parseHashParams() {
  const h = (globalThis.window?.location?.hash || "").replace(/^#/, "");
  const p = new URLSearchParams(h);
  return {
    model: p.get("model") || p.get("res_model") || p.get("active_model") || null,
    id: p.get("id") || null,
    view_type: p.get("view_type") || null,
  };
}

// Resolve Odoo field metadata from OWL attributes, form widgets, or list cells.
function resolveOwlFieldMeta(el) {
  const wrapper = el?.closest?.("[data-odoo-field]");
  const field = wrapper?.getAttribute?.("data-odoo-field") || null;
  if (!field) return null;
  return {
    field,
    label: wrapper.getAttribute?.("data-odoo-field-label") || field,
    model: wrapper.getAttribute?.("data-odoo-model") || null,
  };
}

function resolveFieldName(el, owlFieldMeta = resolveOwlFieldMeta(el)) {
  if (!el) return null;
  if (owlFieldMeta?.field) return owlFieldMeta.field;

  const fw = el.closest?.(".o_field_widget[data-name]");
  if (fw?.dataset?.name) return fw.dataset.name;

  const td = el.closest?.("td[data-name], th[data-name]");
  if (td?.dataset?.name) return td.dataset.name;

  const any = el.closest?.("[data-name]");
  if (any?.getAttribute?.("data-name")) return any.getAttribute("data-name");

  const name = el.getAttribute?.("name");
  if (name) return name;

  // Fall back to element ID prefix for portaled autocomplete dropdown options.
  if (!isEphemeralDomId(el.id)) {
    const idMatch = /^([a-z_][a-z0-9_]*?)(?:_\d+)+$/i.exec(el.id || "");
    if (idMatch) return idMatch[1];
  }

  return null;
}

function resolveListRecordSelector(rawTarget, domEventType) {
  if (!rawTarget?.closest) return null;
  const rowCell = rawTarget.closest("td.o_list_record_selector");
  const headerCell = !rowCell ? rawTarget.closest("th.o_list_record_selector") : null;
  const selectorCell = rowCell || headerCell;
  if (!selectorCell) return null;

  const listRoot = selectorCell.closest("table, .o_list_renderer, .o_list_view");
  const rowCheckboxes = listRoot?.querySelectorAll
    ? Array.from(
        listRoot.querySelectorAll(
          "tbody tr.o_data_row td.o_list_record_selector input[type='checkbox']"
        )
      )
    : [];
  let selectedCount = rowCheckboxes.filter((cb) => !!cb.checked).length;

  const cellCheckbox = selectorCell.querySelector?.("input[type='checkbox']") || null;
  const clickedWrapperBeforeToggle =
    domEventType === "click" && cellCheckbox && rawTarget !== cellCheckbox;

  let checked = cellCheckbox ? !!cellCheckbox.checked : true;
  if (rowCell) {
    if (clickedWrapperBeforeToggle) {
      checked = !cellCheckbox.checked;
      selectedCount = Math.max(0, selectedCount + (checked ? 1 : -1));
    }
  } else if (headerCell) {
    if (clickedWrapperBeforeToggle) {
      checked = !cellCheckbox.checked;
      selectedCount = checked ? rowCheckboxes.length : 0;
    } else if (checked && selectedCount === 0 && rowCheckboxes.length > 0) {
      selectedCount = rowCheckboxes.length;
    }
  }

  return {
    isSelectAll: !!headerCell,
    target_name: headerCell ? "list.select_all" : "list.select_row",
    selector: headerCell
      ? "th.o_list_record_selector input[type='checkbox']"
      : "td.o_list_record_selector input[type='checkbox']",
    label: headerCell ? "Select all records" : "Select record",
    selected_count: selectedCount,
    total_rows: rowCheckboxes.length,
    checked,
  };
}

const BREADCRUMB_TOOLTIP_PREFIX_RE =
  /^(?:back\s+to|volver\s+a|regresar\s+a|retour\s+[àa]|zur[üu]ck\s+zu|torna\s+a)\s+/i;

function stripBreadcrumbTooltipPrefix(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";
  const withoutPrefix = cleaned.replace(BREADCRUMB_TOOLTIP_PREFIX_RE, "").trim();
  return cleanText(withoutPrefix.replace(/^["'«“”]+|["'»“”]+$/g, ""));
}

function resolveBreadcrumbTarget(rawTarget) {
  if (!rawTarget?.closest) return null;
  const anchor = rawTarget.closest(
    ".o_control_panel_breadcrumbs .breadcrumb-item a, " +
      ".o_navbar_breadcrumbs .breadcrumb-item a, " +
      ".o_fallback_breadcrumbs .breadcrumb-item a, " +
      ".o_breadcrumb .breadcrumb-item a, " +
      ".o_back_button"
  );
  if (!anchor) return null;

  const visibleText = cleanText(anchor.innerText || anchor.textContent || "");
  const tooltipText = stripBreadcrumbTooltipPrefix(
    anchor.getAttribute?.("data-tooltip") ||
      anchor.getAttribute?.("title") ||
      anchor.getAttribute?.("aria-label") ||
      ""
  );
  const label = visibleText || tooltipText || "Back";
  const slug = slugify(label);

  return {
    element: anchor,
    label,
    target_name: slug ? `breadcrumb.${slug}` : "breadcrumb.back",
    selector: ".o_control_panel_breadcrumbs .breadcrumb-item a, .o_back_button",
  };
}

function resolveRowResId(el) {
  const row = el?.closest?.("tr");
  if (!row) return null;
  return normalizePersistentRecordId(
    row.getAttribute?.("data-res-id") ||
      row.getAttribute?.("data-id") ||
      row.dataset?.id
  );
}

function resolveKanbanRecord(el) {
  const record = el?.closest?.(".o_kanban_record");
  if (!record) return null;

  const rawId =
    record.getAttribute?.("data-res-id") ||
    record.getAttribute?.("data-id") ||
    record.dataset?.resId ||
    record.dataset?.id ||
    null;
  const resId =
    normalizePersistentRecordId(rawId) || null;

  return {
    element: record,
    res_id: resId,
    client_record_id: transientClientRecordId(rawId),
    label: cleanText(
      record.getAttribute?.("title") ||
        record.querySelector?.(".o_kanban_record_title")?.textContent ||
        record.querySelector?.("[name='name']")?.textContent ||
        record.innerText ||
        record.textContent ||
        ""
    ),
  };
}

function isKanbanCardNavigation(el, kanbanRecord) {
  if (!el || !kanbanRecord?.element) return false;

  const secondaryControl = el.closest?.(
    "button, input, textarea, select, [role='button'], [role='menuitem'], " +
      ".btn, .dropdown-item, .o_kanban_manage_button, .o_dropdown"
  );

  return !secondaryControl || !kanbanRecord.element.contains?.(secondaryControl);
}

function resolveButtonName(el) {
  if (!el) return null;

  const btn = el.closest?.("button,[role='button'],a") || el;
  const cls = (btn.className || "").toString();

  // Odoo standard
  if (/\bo_form_button_save\b/.test(cls)) return "form.save";
  if (/\bo_form_button_cancel\b/.test(cls)) return "form.discard";
  if (/\bo_form_button_create\b/.test(cls)) return "form.create";
  if (/\bo_list_button_add\b/.test(cls)) return "list.create";
  if (/\bo-kanban-button-new\b/.test(cls)) return "kanban.create";

  // Odoo object/action buttons
  const name = btn.getAttribute?.("name");
  if (name) return name;

  // Some Odoo menus/links expose xmlid
  const ds = btn.dataset || {};
  const xmlid = ds.menuXmlid || ds.menuXmlId || ds.xmlid;
  if (xmlid) return `menu.${xmlid}`;

  // Title as last-resort (not ideal, but better than innerText)
  const title = btn.getAttribute?.("title");
  if (title) return `btn.${slugify(title)}`;

  return null;
}

function resolveTabTarget(el) {
  return el?.closest?.(
    ".o_notebook_headers .nav-link, .o_notebook [role='tab'], [role='tab']"
  ) || null;
}

function resolveTabName(tabEl) {
  if (!tabEl) return null;

  const ds = tabEl.dataset || {};
  if (ds.pageId) return ds.pageId;

  const href = tabEl.getAttribute?.("href") || "";
  const hrefMatch = href.match(/^#(.+)$/);
  if (hrefMatch) return hrefMatch[1];

  const name = tabEl.getAttribute?.("name");
  if (name) return name;

  return slugify(cleanText(tabEl.innerText || tabEl.textContent || "")) || null;
}

function resolveRadioOption(el) {
  if (!el || el.type !== "radio") return null;

  // Read technical value from data-value and visible text from the radio label.
  const labelEl =
    (el.id &&
      el.ownerDocument?.querySelector?.(`label[for="${safeCssEscape(el.id)}"]`)) ||
    el.closest?.(".o_radio_item, .form-check")?.querySelector?.("label") ||
    null;

  return {
    label: cleanText(labelEl?.innerText || labelEl?.textContent || "") || null,
    value: el.getAttribute?.("data-value") ?? el.dataset?.value ?? null,
  };
}

function resolveAutocompleteOption(el) {
  const option = el?.closest?.(
    ".o-autocomplete--dropdown-item, .o-autocomplete .dropdown-item, .ui-menu-item-wrapper, [role='option']"
  );
  if (!option) return null;

  const isCreate = !!option.closest?.(".o_m2o_dropdown_option_create");
  return {
    element: option,
    action: isCreate ? "create" : "select",
    text: cleanText(option.innerText || option.textContent || ""),
  };
}

function classifyKind(el) {
  const tag = (el?.tagName || "").toUpperCase();
  const type = (el?.getAttribute?.("type") || "").toLowerCase();
  const role = (el?.getAttribute?.("role") || "").toLowerCase();

  if (role === "button" || tag === "BUTTON") return "button";
  if (tag === "A") return "link";

  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (type === "checkbox" || role === "checkbox") return "field";
    return "field";
  }
  return "other";
}

function computeQuality({ model, view_type, field, target_name, owlFieldMeta }) {
  const missing = [];
  const sources = {};

  if (model) sources.model = owlFieldMeta ? "owl_props" : "context_service|hash";
  else missing.push("model");

  if (view_type && view_type !== "unknown") sources.view_type = "dom|hash|context_service";
  else missing.push("view_type");

  if (field) sources.field = owlFieldMeta ? "owl_props" : "data-name|name";
  else missing.push("field");

  if (target_name) sources.target_name = owlFieldMeta ? "owl_props" : "class|name|dataset|title";
  else missing.push("target_name");

  let level = "strong";
  if (missing.length >= 2) level = "weak";
  else if (missing.length === 1) level = "ok";

  return { level, missing, sources };
}

// Normalize a DOM event into canonical ticket fields and rich evidence metadata.
export function normalizeDomEvent({
  domEventType,
  originalEvent,
  contextService,
  context = null,
}) {
  const e = originalEvent;
  const rawTarget = e?.target || null;
  const el = rawTarget?.closest?.("button,a,input,textarea,select,[role='button'],[role='menuitem']") || rawTarget;
  const owlFieldMeta = resolveOwlFieldMeta(rawTarget);

  const ctx = (() => {
    if (context && typeof context === "object") return context;
    try { return contextService?.getContext?.() || {}; } catch { return {}; }
  })();

  const hash = parseHashParams();
  const kanbanRecord = resolveKanbanRecord(rawTarget);
  const listSelection = resolveListRecordSelector(rawTarget, domEventType);
  const breadcrumbTarget =
    domEventType === "click" && !listSelection ? resolveBreadcrumbTarget(rawTarget) : null;

  const model = owlFieldMeta?.model || ctx.model || hash.model || null;
  const view_type =
    (kanbanRecord && "kanban") ||
    (listSelection && "list") ||
    ctx.view_type ||
    ctx.viewType ||
    ctx.view ||
    hash.view_type ||
    detectActiveViewType();

  const kind = classifyKind(el);
  const row_res_id = resolveRowResId(el);
  const res_id = kanbanRecord
    ? kanbanRecord.res_id
    : row_res_id ??
      ctx.res_id ??
      ctx.resId ??
      normalizePersistentRecordId(hash.id) ??
      null;

  // Determine normalized type + identifiers
  let type = "unknown";
  let field = null;
  let value = null;
  let target_name = null;
  let autocompleteOption = null;
  let radioOption = null;

  if (listSelection && (domEventType === "click" || domEventType === "change")) {
    type = "list_selection_changed";
    field = null;
    target_name = listSelection.target_name;
    value = listSelection.selected_count;
  } else if (breadcrumbTarget && domEventType === "click") {
    type = "link_clicked";
    field = null;
    target_name = breadcrumbTarget.target_name;
  } else if (domEventType === "change" || domEventType === "input_final") {
      type = "field_changed";
      field = resolveFieldName(el, owlFieldMeta);

      radioOption = resolveRadioOption(el);
      if (el?.type === "checkbox") {
        value = !!el.checked;  // Use boolean state for checkboxes.
      } else if (radioOption) {
        // el.value is "on" for Odoo radios; prefer the visible option label.
        value = radioOption.label || radioOption.value;
      } else {
        value = el && "value" in el ? el.value : null;
      }

      target_name = field || null;
  } else if (domEventType === "click") {
    // button vs link vs other
    const menuTarget = el?.closest?.(
      "[data-menu-xmlid], .o_app, .o_menuitem, [role='menuitem']"
    );
    const menuClick =
      model === "ir.ui.menu" ||
      !!menuTarget ||
      String(resolveButtonName(el) || "").startsWith("menu.");
    const tabTarget = resolveTabTarget(rawTarget);
    autocompleteOption = resolveAutocompleteOption(rawTarget);

    if (kanbanRecord && view_type === "kanban" && isKanbanCardNavigation(el, kanbanRecord)) {
      type = "card_clicked";
      field = "kanban.card";
      target_name = "kanban.card";
    }
    else if (tabTarget) {
      type = "tab_changed";
      target_name = resolveTabName(tabTarget);
      field = target_name;
    }
    else if (autocompleteOption) {
      // Resolve Many2one autocomplete field via OWL metadata or ID prefix fallback.
      type = "link_clicked";
      field = resolveFieldName(el, owlFieldMeta);
      target_name = field;
      value = autocompleteOption.text || null;
    }
    else if (menuClick) {
      type = "menu_clicked";
      // Keep xmlid slug in target_name for evidence; use visible text as label
      target_name = resolveButtonName(el);
      field = target_name;
    }
    else if (kind === "button") type = "button_clicked";
    else if (kind === "link") type = "link_clicked";
    else type = "click";

    if (type !== "tab_changed" && !autocompleteOption) {
      target_name = resolveButtonName(el);
      // some clicks are effectively on fields (e.g. checkbox)
      if (!target_name && kind === "field") {
        field = resolveFieldName(el);
        target_name = field || null;
      }
    }
  } else {
    type = domEventType || "unknown";
  }

  // Prefer visible text for menu click labels and keep xmlid in target_name.
  const menuVisibleText =
    type === "menu_clicked"
      ? cleanText(el?.getAttribute?.("title") || el?.innerText || el?.textContent || "")
      : null;

  // Detect whether the event originates inside a dialog/modal.
  const inModal = !!(rawTarget?.closest?.(".o_dialog, .o_dialog_container, .modal"));

  // label strategy: never rely on visible labels for identity, but we can emit for human readability
  const label =
    listSelection?.label ||
    breadcrumbTarget?.label ||
    menuVisibleText ||
    kanbanRecord?.label ||
    autocompleteOption?.text ||
    (type === "field_changed" ? owlFieldMeta?.label : null) ||
    field ||
    target_name ||
    cleanText(el?.getAttribute?.("title") || "") ||
    cleanText(el?.innerText || el?.textContent || "") ||
    null;

  const selector = listSelection?.selector || breadcrumbTarget?.selector || buildSelector(el);
  const dom_key = listSelection
    ? listSelection.target_name
    : breadcrumbTarget
      ? breadcrumbTarget.target_name
      : (el?.tagName ? el.tagName.toLowerCase() : "el") +
        (field ? `.${field}` : target_name ? `.${slugify(target_name)}` : selector ? `.${slugify(selector)}` : "");

  const quality = computeQuality({ model, view_type, field, target_name, owlFieldMeta });

  const normalized = {
    // ticket payload
    type: canonicalEventType(type),
    label: label || null,
    field: field || null,
    value: value ?? null,

    // extras (evidence)
    meta: {
      model,
      view_type: inModal ? "modal" : view_type,
      res_id,
      row_res_id,
      kind,
      target_name: target_name || null,
      card_res_id: kanbanRecord?.res_id ?? null,
      client_record_id: kanbanRecord?.client_record_id ?? null,
      in_modal: inModal || undefined,
      m2o_action: autocompleteOption?.action,
      radio_value: radioOption?.value ?? undefined,
      ...(listSelection
        ? {
            selected_count: listSelection.selected_count,
            total_rows: listSelection.total_rows,
            selection_checked: listSelection.checked,
          }
        : {}),
      ...(breadcrumbTarget
        ? {
            navigation_kind: "breadcrumb_back",
            breadcrumb_label: breadcrumbTarget.label,
          }
        : {}),
    },
    dom: {
      tag: (el?.tagName || "").toLowerCase() || null,
      id: isEphemeralDomId(el?.id) ? null : el?.id || null,
      nameAttr: el?.getAttribute?.("name") || null,
      dataName: el?.dataset?.name || el?.getAttribute?.("data-name") || null,
      className: (el?.className || "").toString().slice(0, 200),
      selector,
      css_path: cssPath(el),
      dom_key,
      text_preview: cleanText(el?.innerText || el?.textContent || ""),
    },
    quality,
    ts: new Date().toISOString(),
    v: 1,
  };

  return normalized;
}
