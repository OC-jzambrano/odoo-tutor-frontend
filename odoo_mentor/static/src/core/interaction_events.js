/* eslint-disable */
/** @odoo-module **/

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim() || null;
}

function base(name, context = {}) {
  return {
    type: name,
    name,
    model: context.model || null,
    res_id: context.resId ?? context.res_id ?? null,
  };
}

export function buildNotificationShownEvent(notification = {}, context = {}) {
  return {
    ...base("notification_shown", context),
    notification_type: notification.type || "info",
    title: clean(notification.title),
    message: clean(notification.message),
  };
}

export function buildKanbanMovedEvent(move = {}, context = {}) {
  if (!move.from_group || !move.to_group || move.from_group === move.to_group) return null;
  return {
    ...base("kanban_record_moved", context),
    record_id: move.record_id ?? null,
    record_name: clean(move.record_name),
    from_group: clean(move.from_group),
    to_group: clean(move.to_group),
  };
}

export function buildX2ManyRowEvent({ field, before, after } = {}, context = {}) {
  if (!field || before === after) return null;
  const name = after > before ? "x2many_row_added" : "x2many_row_removed";
  return {
    ...base(name, context),
    field,
    previous_count: before,
    current_count: after,
    delta: after - before,
  };
}

export function buildSearchChangedEvent(search = {}, context = {}) {
  return {
    ...base("search_changed", context),
    query: clean(search.query) || "",
    filters: (search.filters || []).map(clean).filter(Boolean),
  };
}
