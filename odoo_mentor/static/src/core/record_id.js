/* eslint-disable */
/** @odoo-module **/

export function transientClientRecordId(value) {
  return /^datapoint_/i.test(String(value || "")) ? String(value) : null;
}

export function normalizePersistentRecordId(value) {
  if (
    value == null ||
    value === "" ||
    value === false ||
    transientClientRecordId(value)
  ) {
    return null;
  }
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) {
    return numberValue > 0 ? numberValue : null;
  }
  return String(value);
}
