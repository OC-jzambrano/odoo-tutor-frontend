/* eslint-disable */
/** @odoo-module **/

import { canonicalEventType } from "./event_types";

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

function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let sel = node.nodeName.toLowerCase();
    if (node.id) {
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
  if (el.id) return `#${safeCssEscape(el.id)}`;
  if (el.dataset?.name) return `[data-name="${safeCssEscape(el.dataset.name)}"]`;
  const name = el.getAttribute?.("name");
  if (name) return `${(el.tagName || "").toLowerCase()}[name="${safeCssEscape(name)}"]`;
  const tag = (el.tagName || "").toLowerCase();
  const cls = (el.className || "").toString().split(/\s+/).filter(Boolean)[0];
  if (cls) return `${tag}.${safeCssEscape(cls)}`;
  return tag || null;
}

function guessViewType() {
  if (document.querySelector(".o_form_view")) return "form";
  if (document.querySelector(".o_list_view, .o_list_renderer")) return "list";
  if (document.querySelector(".o_kanban_view")) return "kanban";
  if (document.querySelector(".o_graph_view")) return "graph";
  if (document.querySelector(".o_pivot_view")) return "pivot";
  return "unknown";
}

function parseHashParams() {
  const h = (window.location.hash || "").replace(/^#/, "");
  const p = new URLSearchParams(h);
  return {
    model: p.get("model") || p.get("res_model") || p.get("active_model") || null,
    id: p.get("id") || null,
    view_type: p.get("view_type") || null,
  };
}

function safeId(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/**
 * Odoo-aware field resolver:
 * - form fields: .o_field_widget[data-name]
 * - list cells: td[data-name]
 * - fallback: name attr
 */
function resolveFieldName(el) {
  if (!el) return null;

  const fw = el.closest?.(".o_field_widget[data-name]");
  if (fw?.dataset?.name) return fw.dataset.name;

  const td = el.closest?.("td[data-name], th[data-name]");
  if (td?.dataset?.name) return td.dataset.name;

  const any = el.closest?.("[data-name]");
  if (any?.getAttribute?.("data-name")) return any.getAttribute("data-name");

  const name = el.getAttribute?.("name");
  if (name) return name;

  return null;
}

function resolveRowResId(el) {
  const row = el?.closest?.("tr");
  if (!row) return null;
  return safeId(row.getAttribute?.("data-res-id") || row.getAttribute?.("data-id") || row.dataset?.id);
}

function resolveButtonName(el) {
  if (!el) return null;

  const btn = el.closest?.("button,[role='button'],a") || el;
  const cls = (btn.className || "").toString();

  // Odoo standard
  if (/\bo_form_button_save\b/.test(cls)) return "form.save";
  if (/\bo_form_button_cancel\b/.test(cls)) return "form.discard";
  if (/\bo_list_button_add\b/.test(cls)) return "list.create";

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

function computeQuality({ model, view_type, field, target_name }) {
  const missing = [];
  const sources = {};

  if (model) sources.model = "context_service|hash";
  else missing.push("model");

  if (view_type && view_type !== "unknown") sources.view_type = "dom|hash|context_service";
  else missing.push("view_type");

  if (field) sources.field = "data-name|name";
  else missing.push("field");

  if (target_name) sources.target_name = "class|name|dataset|title";
  else missing.push("target_name");

  let level = "strong";
  if (missing.length >= 2) level = "weak";
  else if (missing.length === 1) level = "ok";

  return { level, missing, sources };
}

/**
 * Main normalizer: produces BOTH
 * - ticket style: {type,label,field,value}
 * - rich meta for evidence: {meta, quality, dom}
 */
export function normalizeDomEvent({ domEventType, originalEvent, contextService }) {
  const e = originalEvent;
  const rawTarget = e?.target || null;
  const el = rawTarget?.closest?.("button,a,input,textarea,select,[role='button'],[role='menuitem']") || rawTarget;

  const ctx = (() => {
    try { return contextService?.getContext?.() || {}; } catch { return {}; }
  })();

  const hash = parseHashParams();

  const model = ctx.model || hash.model || null;
  const view_type = ctx.view_type || ctx.view || hash.view_type || guessViewType();

  const kind = classifyKind(el);
  const row_res_id = resolveRowResId(el);
  const res_id = ctx.resId ?? ctx.res_id ?? safeId(hash.id) ?? row_res_id ?? null;

  // Determine normalized type + identifiers
  let type = "unknown";
  let field = null;
  let value = null;
  let target_name = null;

  if (domEventType === "change" || domEventType === "input_final") {
      type = "field_changed";
      field = resolveFieldName(el);

      if (el?.type === "checkbox") {
        value = !!el.checked;   // 🔥 boolean real
      } else {
        value = el && "value" in el ? el.value : null;
      }

      target_name = field || null;
    } else if (domEventType === "click") {
    // button vs link vs other
    if (kind === "button") type = "button_clicked";
    else if (kind === "link") type = "link_clicked";
    else type = "click";

    target_name = resolveButtonName(el);
    // some clicks are effectively on fields (e.g. checkbox)
    if (!target_name && kind === "field") {
      field = resolveFieldName(el);
      target_name = field || null;
    }
  } else {
    type = domEventType || "unknown";
  }

  // label strategy: never rely on visible labels for identity, but we can emit for human readability
  const label =
    field ||
    target_name ||
    cleanText(el?.getAttribute?.("title") || "") ||
    cleanText(el?.innerText || el?.textContent || "") ||
    null;

  const selector = buildSelector(el);
  const dom_key =
    (el?.tagName ? el.tagName.toLowerCase() : "el") +
    (field ? `.${field}` : target_name ? `.${slugify(target_name)}` : selector ? `.${slugify(selector)}` : "");

  const quality = computeQuality({ model, view_type, field, target_name });

  const normalized = {
    // ticket payload
    type: canonicalEventType(type),
    label: label || null,
    field: field || null,
    value: value ?? null,

    // extras (evidence)
    meta: {
      model,
      view_type,
      res_id,
      row_res_id,
      kind,
      target_name: target_name || null,
    },
    dom: {
      tag: (el?.tagName || "").toLowerCase() || null,
      id: el?.id || null,
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
