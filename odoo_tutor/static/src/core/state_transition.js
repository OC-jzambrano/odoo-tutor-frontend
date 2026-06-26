/* eslint-disable */
/** @odoo-module **/

function normalizeId(value) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
}

function compactState(state = {}) {
  return {
    model: state.model || state.currentModel || null,
    view_type: state.view_type || state.view || null,
    res_id: normalizeId(state.res_id ?? state.resId),
  };
}

export function buildRecordOpenedTransition({ from = {}, to = {} } = {}) {
  const fromState = compactState(from);
  const toState = compactState(to);

  if (!toState.model || toState.view_type !== "form" || !toState.res_id) {
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
    },
  };
}
