/* eslint-disable */
/** @odoo-module **/

import { normalizePersistentRecordId } from "./record_id";

function normalizeRecordIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => normalizePersistentRecordId(item?.id ?? item))
    .filter((item) => item != null);
}

function mutationValues(method, args) {
  if (method === "create") return args?.[0]?.[0] || args?.[0] || {};
  if (method === "write" || method === "web_save") return args?.[1] || {};
  return {};
}

function resultRecordIds(result) {
  if (Array.isArray(result)) return normalizeRecordIds(result);
  if (result && typeof result === "object") {
    return normalizeRecordIds(result.id ?? result.ids ?? result.records ?? []);
  }
  return normalizeRecordIds(result);
}

function eventData(name, model, ids, values = {}, extra = {}) {
  const recordIds = normalizeRecordIds(ids);
  return {
    type: name,
    name,
    model: model || null,
    res_ids: recordIds,
    res_id: recordIds[0] ?? null,
    changed_fields: Object.keys(values || {}).sort(),
    ...extra,
  };
}

export function buildSuccessfulOrmEvent({ model, method, args = [], result } = {}) {
  const values = mutationValues(method, args);

  if (method === "create") {
    return eventData("record_created", model, resultRecordIds(result), values);
  }

  if (method === "web_save") {
    const existingIds = normalizeRecordIds(args[0]);
    if (!existingIds.length) {
      return eventData("record_created", model, resultRecordIds(result), values);
    }
    if (values.active === false) {
      return eventData("record_archived", model, existingIds, values);
    }
    return eventData("record_saved", model, existingIds, values);
  }

  if (method === "write") {
    const ids = normalizeRecordIds(args[0]);
    return eventData(
      values.active === false ? "record_archived" : "record_saved",
      model,
      ids,
      values
    );
  }

  if (method === "unlink") {
    return eventData("record_deleted", model, args[0]);
  }

  if (method === "action_archive") {
    return eventData("record_archived", model, args[0], { active: false });
  }

  return null;
}

export function isValidationError(error) {
  const identity = [
    error?.name,
    error?.data?.name,
    error?.data?.exception_type,
    error?.cause?.name,
  ]
    .filter(Boolean)
    .join(" ");
  return /validationerror|validation_error|constraint/i.test(identity);
}

export function buildValidationErrorEvent({ model, method, args = [], error } = {}) {
  if (!isValidationError(error)) return null;

  const ids = method === "create" ? [] : args[0];
  return eventData("validation_error", model, ids, mutationValues(method, args), {
    operation: method || null,
    error_name: error?.data?.name || error?.name || "ValidationError",
    message: error?.data?.message || error?.message || null,
  });
}
