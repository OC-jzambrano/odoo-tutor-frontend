/* eslint-disable */
/** @odoo-module **/

import { normalizePersistentRecordId } from "./record_id";

function fieldName(element) {
  return (
    element?.getAttribute?.("name") ||
    element?.closest?.("[name]")?.getAttribute?.("name") ||
    null
  );
}

export function buildClientValidationEvent({ elements = [], context = {} } = {}) {
  const invalidFields = [...new Set(elements.map(fieldName).filter(Boolean))].sort();
  if (!elements.length) return null;

  const resId = normalizePersistentRecordId(context.res_id ?? context.resId);
  const messages = [
    ...new Set(
      elements
        .map((element) => element?.validationMessage)
        .filter(Boolean)
    ),
  ];

  return {
    type: "validation_error",
    name: "validation_error",
    model: context.model || null,
    res_ids: resId == null ? [] : [resId],
    res_id: resId,
    invalid_fields: invalidFields,
    validation_scope: "client",
    message: messages.join("; ") || null,
  };
}
