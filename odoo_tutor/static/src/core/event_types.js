/* eslint-disable */
/** @odoo-module **/

export const EVENT_TYPE_ALIASES = Object.freeze({
  button_click: "button_clicked",
  link_click: "link_clicked",
});

export function canonicalEventType(type) {
  const value = (type || "").toString().trim();
  return EVENT_TYPE_ALIASES[value] || value;
}

export function canonicalizeEvent(event) {
  if (!event || typeof event !== "object") return event;
  const type = canonicalEventType(event.type);
  const rawMeta = event.meta && typeof event.meta === "object" ? event.meta : null;
  if (!rawMeta) {
    return type === event.type ? event : { ...event, type };
  }

  const {
    viewType,
    resId,
    rowId,
    cardResId,
    targetName,
    ...meta
  } = rawMeta;

  return {
    ...event,
    type,
    meta: {
      ...meta,
      view_type: meta.view_type ?? viewType ?? null,
      res_id: meta.res_id ?? resId ?? null,
      row_res_id: meta.row_res_id ?? rowId ?? null,
      card_res_id: meta.card_res_id ?? cardResId ?? null,
      target_name: meta.target_name ?? targetName ?? null,
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (!["timestamp", "ts", "clicked_at"].includes(key)) {
        result[key] = stableValue(value[key]);
      }
      return result;
    }, {});
}

export function canonicalEventFingerprint(event) {
  return JSON.stringify(stableValue(canonicalizeEvent(event)));
}
