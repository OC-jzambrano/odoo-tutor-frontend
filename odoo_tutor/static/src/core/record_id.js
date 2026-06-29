/* eslint-disable */
/** @odoo-module **/

export function transientClientRecordId(value) {
  return /^datapoint_/i.test(String(value || "")) ? String(value) : null;
}

export function normalizePersistentRecordId(value) {
  if (value == null || value === "" || transientClientRecordId(value)) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
}
