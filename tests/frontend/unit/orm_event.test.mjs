import { describe, expect, it } from "vitest";
import {
  buildSuccessfulOrmEvent,
  buildValidationErrorEvent,
  isValidationError,
} from "../../../odoo_tutor/static/src/core/orm_event.js";

describe("ORM event contract", () => {
  it("emits record_created after create", () => {
    expect(
      buildSuccessfulOrmEvent({
        model: "crm.lead",
        method: "create",
        args: [[{ name: "New lead" }]],
        result: [42],
      })
    ).toMatchObject({
      type: "record_created",
      model: "crm.lead",
      res_ids: [42],
      res_id: 42,
      changed_fields: ["name"],
    });
  });

  it("distinguishes new and existing web_save records", () => {
    const created = buildSuccessfulOrmEvent({
      model: "res.partner",
      method: "web_save",
      args: [[], { name: "Ada" }],
      result: [{ id: 7, name: "Ada" }],
    });
    const saved = buildSuccessfulOrmEvent({
      model: "res.partner",
      method: "web_save",
      args: [[7], { phone: "123" }],
      result: [{ id: 7 }],
    });

    expect(created.name).toBe("record_created");
    expect(created.res_ids).toEqual([7]);
    expect(saved.name).toBe("record_saved");
    expect(saved.res_ids).toEqual([7]);
  });

  it("emits record_archived for active false and action_archive", () => {
    expect(
      buildSuccessfulOrmEvent({
        model: "crm.lead",
        method: "write",
        args: [[3], { active: false }],
        result: true,
      }).name
    ).toBe("record_archived");
    expect(
      buildSuccessfulOrmEvent({
        model: "crm.lead",
        method: "action_archive",
        args: [[3]],
        result: true,
      }).name
    ).toBe("record_archived");
  });

  it("reserves record_deleted for successful unlink", () => {
    expect(
      buildSuccessfulOrmEvent({
        model: "crm.lead",
        method: "unlink",
        args: [[3, 4]],
        result: true,
      })
    ).toMatchObject({
      name: "record_deleted",
      res_ids: [3, 4],
    });
  });

  it("ignores read-only and unrelated ORM calls", () => {
    expect(
      buildSuccessfulOrmEvent({
        model: "crm.lead",
        method: "search_read",
        args: [[]],
        result: [],
      })
    ).toBeNull();
  });

  it("emits validation_error only for validation failures", () => {
    const error = {
      name: "RPC_ERROR",
      message: "Validation failed",
      data: {
        name: "odoo.exceptions.ValidationError",
        message: "Expected revenue must be positive",
      },
    };

    expect(isValidationError(error)).toBe(true);
    expect(
      buildValidationErrorEvent({
        model: "crm.lead",
        method: "write",
        args: [[9], { expected_revenue: -1 }],
        error,
      })
    ).toMatchObject({
      name: "validation_error",
      model: "crm.lead",
      res_ids: [9],
      operation: "write",
      error_name: "odoo.exceptions.ValidationError",
      message: "Expected revenue must be positive",
    });
    expect(
      buildValidationErrorEvent({
        model: "crm.lead",
        method: "write",
        args: [[9], {}],
        error: { name: "NetworkError" },
      })
    ).toBeNull();
  });
});
