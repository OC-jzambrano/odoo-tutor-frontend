/* eslint-disable */
/** @odoo-module **/

function slugify(s) {
  return (s || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

function cleanText(x) {
  return (x || "").toString().trim().replace(/\s+/g, " ");
}

function isTabElement(el) {
  if (!el) return false;
  if (el.getAttribute?.("role") === "tab") return true;

  // Odoo notebook/tabs
  if (el.closest?.(".nav-tabs, .o_notebook, .o_notebook_headers")) return true;

  // tu caso: span con data-section
  if (el.getAttribute?.("data-section")) return true;
  if (el.closest?.("[data-section]")) return true;

  return false;
}

function extractTabValue(el) {
  const section =
    el?.getAttribute?.("data-section") ||
    el?.closest?.("[data-section]")?.getAttribute?.("data-section");

  const txt = cleanText(el?.textContent || "");
  return section ? `section:${section}` : `tab:${slugify(txt)}`;
}

function getControlLabel(el) {
  if (!el) return null;

  // 1) label[for=id]
  const id = el.id || el.getAttribute?.("id");
  if (id) {
    try {
      const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
      const lab = document.querySelector(`label[for="${sel}"]`);
      const t = cleanText(lab?.textContent || "");
      if (t) return t;
    } catch {}
  }

  // 2) label cercano
  const wrap = el.closest?.("label, .o_form_label, .o_setting_label, .form-check");
  if (wrap) {
    const lab = wrap.querySelector?.("label") || (wrap.tagName === "LABEL" ? wrap : null);
    const t = cleanText(lab?.textContent || "");
    if (t) return t;
  }

  // 3) title / aria-label / texto
  const t =
    cleanText(el.getAttribute?.("aria-label") || "") ||
    cleanText(el.getAttribute?.("title") || "") ||
    cleanText(el.textContent || "");

  return t || null;
}

function buildTargetFallback(el) {
  if (!el) return "unknown";

  const tag = (el.tagName || "").toLowerCase();
  const dataName = el.getAttribute?.("data-name") || el.dataset?.name;
  if (dataName) return `${tag}.${dataName}`;

  const name = el.getAttribute?.("name");
  if (name) return `${tag}.${name}`;

  const id = el.id;
  if (id) return `${tag}#${id}`;

  const role = el.getAttribute?.("role");
  if (role) return `${tag}[role=${role}]`;

  const cls = (el.className || "").toString().split(/\s+/).filter(Boolean)[0];
  if (cls) return `${tag}.${cls}`;

  return tag || "unknown";
}

function safeId(value) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
}

function resolveKanbanRecord(el) {
  const record = el?.closest?.(".o_kanban_record");
  if (!record) return null;

  const resId = safeId(
    record.getAttribute?.("data-res-id") ||
      record.getAttribute?.("data-id") ||
      record.dataset?.resId ||
      record.dataset?.id
  );

  const label = cleanText(
    record.getAttribute?.("title") ||
      record.querySelector?.(".o_kanban_record_title")?.textContent ||
      record.querySelector?.("[name='name']")?.textContent ||
      record.textContent ||
      ""
  );

  return {
    element: record,
    resId,
    label,
  };
}

function classifyUiType(el) {
  const tag = (el?.tagName || "").toUpperCase();
  const type = (el?.getAttribute?.("type") || "").toLowerCase();
  const role = (el?.getAttribute?.("role") || "").toLowerCase();

  if (type === "checkbox" || role === "checkbox") return "Checkbox";
  if (tag === "BUTTON" || role === "button") return "Button";
  if (tag === "A" || role === "link" || role === "menuitem" || role === "tab") return "Link";
  if (tag === "SELECT") return "Select";
  if (tag === "INPUT" || tag === "TEXTAREA") return "Input";
  return "Other";
}

/**
 * Normaliza eventos DOM -> tu formato.
 * opts:
 * - domEventType: "click" | "change" | "input"
 * - originalEvent: evento DOM
 * - context: { model, viewType, resId }
 */
export function normalizeDomEvent({ domEventType, originalEvent, context, hints }) {
  const e = originalEvent;
  const rawTarget = e?.target || null;
  if (!rawTarget) return null;

  // target “útil”
  const target =
    rawTarget.closest?.("button,a,input,textarea,select,[role='button'],[role='tab']") || rawTarget;

  const uiType = classifyUiType(target);
  const label = getControlLabel(target);
  const kanbanRecord = resolveKanbanRecord(rawTarget);

  // meta mínimo (no inventar)
  const meta = {
    model: context?.model || null,
    viewType: context?.viewType || null,
    resId: context?.resId || kanbanRecord?.resId || null,
  };

  // Kanban record clicks are semantic navigation events. Detect them before
  // generic button/link handling because Odoo cards often contain anchors.
  if (domEventType === "click" && kanbanRecord && context?.viewType === "kanban") {
    const actionable = target.closest?.("button, [role='button'], .btn, .dropdown-item, .o_kanban_manage_button");
    const actionableInsideCard = actionable && kanbanRecord.element?.contains?.(actionable);
    if (!actionableInsideCard) {
      return {
        type: "card_clicked",
        label: kanbanRecord.label || label || cleanText(target.textContent) || null,
        field: "kanban.card",
        value: null,
        meta,
        ts: new Date().toISOString(),
        v: 1,
      };
    }
  }

  // 1) TAB
  if (domEventType === "click" && isTabElement(target)) {
    return {
      type: "tab_changed",
      label: label || cleanText(target.textContent) || null,
      field: "tab",
      value: extractTabValue(target),
      meta,
      ts: new Date().toISOString(),
      v: 1,
    };
  }


  if (domEventType === "change") {
      const td = target.closest?.("td") || null;

      // 1) Campo real de list view: td[data-name]
      const inferredField =
        td?.getAttribute?.("data-name") ||
        td?.dataset?.name ||
        null;

      // 2) Fallbacks: name/data-name del propio control
      const controlField =
        target.getAttribute?.("data-name") ||
        target.dataset?.name ||
        target.getAttribute?.("name") ||
        null;

      // Prioridad: inferredField -> hints -> controlField
      let field =
        inferredField ||
        hints?.lastActiveField ||
        controlField ||
        null;

      // Label: intenta header (th) si es tabla
      let label = getControlLabel(target);
      if (!label && td) {
        try {
          const tr = td.parentElement;
          const table = td.closest("table");
          const ths = table?.querySelectorAll("thead th");
          const idx = td.cellIndex;
          const thText = ths && ths[idx] ? cleanText(ths[idx].textContent || "") : "";
          if (thText) label = thText;
        } catch {}
      }

      const isCheckbox =
        (target.getAttribute?.("type") || "").toLowerCase() === "checkbox";
      const value = isCheckbox ? !!target.checked : (target.value ?? null);

      return {
        type: "field_changed",
        label: label || (field ? field : null),
        field: field || buildTargetFallback(target),
        value,
        meta,
        ts: new Date().toISOString(),
        v: 1,
      };
  }

  // 3) BUTTON CLICKED
  if (domEventType === "click" && uiType === "Button") {
    // intenta dar un field estable
    const name = target.getAttribute?.("name") || target.getAttribute?.("data-name") || target.dataset?.name;
    const field = name ? `button.${name}` : `button.${slugify(label || target.textContent || "unknown")}`;

    return {
      type: "button_clicked",
      label: label || cleanText(target.textContent) || null,
      field,
      value: null,
      meta,
      ts: new Date().toISOString(),
      v: 1,
    };
  }

  // 4) LINK CLICKED / MENU

    // 4) LINK CLICKED / MENU
    if (domEventType === "click" && uiType === "Link") {
      // 1) intenta inferir el field por ancestros típicos de list view
      const carrier =
        target.closest?.("td[data-name], [data-name], [data-field], .o_field_widget[name]") || null;

      const inferredField =
        carrier?.getAttribute?.("data-name") ||
        carrier?.dataset?.name ||
        carrier?.getAttribute?.("data-field") ||
        carrier?.dataset?.field ||
        carrier?.getAttribute?.("name") ||
        carrier?.dataset?.name ||
        null;

      // 2) href a veces es "#", no sirve
      const href = target.getAttribute?.("href") || null;

      // 3) si el click cae en un autocomplete (id=autocomplete_...), usa hint del último field activo
      const id = target.getAttribute?.("id") || "";
      const looksLikeAutocomplete = /^autocomplete_\d+_\d+$/.test(id);

      const field =
        inferredField
          ? inferredField
          : (looksLikeAutocomplete && hints?.lastActiveField)
            ? hints.lastActiveField
            : (href && href !== "#")
              ? `href:${href}`
              : buildTargetFallback(target);

      return {
        type: "link_clicked",
        label: label || cleanText(target.textContent) || null,
        field,
        value: null,
        meta,
        ts: new Date().toISOString(),
        v: 1,
      };
    }

  // 5) fallback click genérico
  if (domEventType === "click") {
    return {
      type: "click",
      label: label || cleanText(target.textContent) || null,
      field: buildTargetFallback(target),
      value: null,
      meta,
      ts: new Date().toISOString(),
      v: 1,
    };
  }

  return null;
}
