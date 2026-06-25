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
  return type === event.type ? event : { ...event, type };
}
