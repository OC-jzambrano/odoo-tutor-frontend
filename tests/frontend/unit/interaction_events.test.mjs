import { describe, expect, it } from "vitest";
import {
  buildKanbanMovedEvent,
  buildNotificationShownEvent,
  buildSearchChangedEvent,
  buildX2ManyRowEvent,
} from "../../../odoo_tutor/static/src/core/interaction_events.js";

describe("additional interaction event contracts", () => {
  const context = { model: "crm.lead", resId: 31 };

  it("builds notification_shown", () => {
    expect(
      buildNotificationShownEvent(
        { type: "warning", title: "Warning", message: " Check values " },
        context
      )
    ).toMatchObject({
      name: "notification_shown",
      notification_type: "warning",
      message: "Check values",
      res_id: 31,
    });
  });

  it("emits kanban_record_moved only across groups", () => {
    expect(
      buildKanbanMovedEvent(
        { record_id: 4, from_group: "New", to_group: "Won" },
        context
      )
    ).toMatchObject({
      name: "kanban_record_moved",
      record_id: 4,
      from_group: "New",
      to_group: "Won",
    });
    expect(
      buildKanbanMovedEvent(
        { from_group: "New", to_group: "New" },
        context
      )
    ).toBeNull();
  });

  it("distinguishes x2many row additions and removals", () => {
    expect(
      buildX2ManyRowEvent(
        { field: "order_line", before: 1, after: 2 },
        context
      ).name
    ).toBe("x2many_row_added");
    expect(
      buildX2ManyRowEvent(
        { field: "order_line", before: 2, after: 1 },
        context
      ).name
    ).toBe("x2many_row_removed");
  });

  it("builds search_changed with query and active filters", () => {
    expect(
      buildSearchChangedEvent(
        { query: " Acme ", filters: ["My Pipeline", " Won "] },
        context
      )
    ).toMatchObject({
      name: "search_changed",
      query: "Acme",
      filters: ["My Pipeline", "Won"],
    });
  });
});
