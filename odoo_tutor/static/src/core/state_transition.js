/* eslint-disable */
/** @odoo-module **/

import { normalizePersistentRecordId } from "./record_id";

function compactState(state = {}) {
  return {
    model: state.model || state.currentModel || null,
    view_type: state.view_type || state.view || null,
    res_id: normalizePersistentRecordId(state.res_id ?? state.resId),
    record_name: state.record_name || state.recordName || null,
  };
}

function cleanRoute(route) {
  return String(route || "").replace(/\s+/g, " ").trim() || null;
}

function transition(name, from, to, extra = {}) {
  return {
    type: name,
    name,
    from,
    to,
    ...extra,
  };
}

const NON_RECORD_MODELS = new Set(["ir.ui.menu", "res.config.settings"]);

export function recordNameFromRoute(route) {
  const parts = String(route || "")
    .split("/")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}

export function buildRecordOpenedTransition({ from = {}, to = {} } = {}) {
  const fromState = compactState(from);
  const toState = compactState(to);

  if (!toState.model || toState.view_type !== "form" || (!toState.res_id && !toState.record_name)) {
    return null;
  }

  if (
    fromState.model === toState.model &&
    fromState.view_type === toState.view_type &&
    fromState.res_id === toState.res_id
  ) {
    return null;
  }

  return {
    type: "state_transition",
    name: "record_opened",
    from: {
      model: fromState.model,
      view_type: fromState.view_type,
    },
    to: {
      model: toState.model,
      view_type: toState.view_type,
      res_id: toState.res_id,
      record_name: toState.record_name,
      res_id_present: toState.res_id != null && toState.res_id !== "",
    },
  };
}

export function buildViewChangedTransition({ from = {}, to = {} } = {}) {
  const fromState = compactState(from);
  const toState = compactState(to);
  if (!toState.view_type || fromState.view_type === toState.view_type) return null;

  return transition(
    "view_changed",
    { model: fromState.model, view_type: fromState.view_type },
    { model: toState.model, view_type: toState.view_type }
  );
}

export function buildRouteChangedTransition({ from_route, to_route, state = {} } = {}) {
  const fromRoute = cleanRoute(from_route);
  const toRoute = cleanRoute(to_route);
  if (!toRoute || fromRoute === toRoute) return null;

  const current = compactState(state);
  return transition(
    "route_changed",
    { route: fromRoute },
    {
      route: toRoute,
      model: current.model,
      view_type: current.view_type,
      res_id: current.res_id,
    }
  );
}

export function buildModalOpenedTransition({
  action = {},
  from = {},
  title = null,
} = {}) {
  if (action?.target !== "new") return null;

  const fromState = compactState(from);
  const model = action.res_model || action.resModel || null;
  const resId = normalizePersistentRecordId(action.res_id ?? action.resId);
  const modalKind = model ? "wizard" : "dialog";

  return transition(
    "modal_opened",
    { model: fromState.model, view_type: fromState.view_type },
    {
      model,
      view_type: "modal",
      res_id: resId,
      res_id_present: resId != null,
    },
    {
      modal_kind: modalKind,
      title: title || action.name || action.display_name || null,
    }
  );
}

export function buildRecordOpenedTransitionFromLiveContext({
  from = {},
  context_model,
  route,
  pending_record = null,
  res_id = null,
} = {}) {
  if (!context_model || NON_RECORD_MODELS.has(context_model)) return null;

  const recordName = recordNameFromRoute(route);
  if (!recordName) return null;

  const pending =
    pending_record?.model === context_model ? compactState(pending_record) : null;

  return buildRecordOpenedTransition({
    from: pending || from,
    to: {
      model: context_model,
      view_type: "form",
      res_id:
        normalizePersistentRecordId(res_id) ??
        normalizePersistentRecordId(pending?.res_id) ??
        null,
      record_name: recordName || pending?.record_name,
    },
  });
}
