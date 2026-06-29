import { describe, expect, it } from "vitest";
import { buildClientValidationEvent } from "../../../odoo_tutor/static/src/core/client_validation_event.js";

function element(name, validationMessage = "") {
  return {
    validationMessage,
    getAttribute(attribute) {
      return attribute === "name" ? name : null;
    },
    closest() {
      return null;
    },
  };
}

describe("client validation event contract", () => {
  it("groups invalid fields into one validation_error", () => {
    expect(
      buildClientValidationEvent({
        elements: [
          element("email", "Complete this field"),
          element("name", "Complete this field"),
          element("email", "Complete this field"),
        ],
        context: { model: "res.partner", resId: 12 },
      })
    ).toEqual({
      type: "validation_error",
      name: "validation_error",
      model: "res.partner",
      res_ids: [12],
      res_id: 12,
      invalid_fields: ["email", "name"],
      validation_scope: "client",
      message: "Complete this field",
    });
  });

  it("supports invalid new records without persistent ids", () => {
    expect(
      buildClientValidationEvent({
        elements: [element("name")],
        context: { model: "crm.lead", resId: "datapoint_4" },
      })
    ).toMatchObject({
      name: "validation_error",
      res_ids: [],
      res_id: null,
      invalid_fields: ["name"],
      validation_scope: "client",
    });
  });

  it("does not emit without invalid elements", () => {
    expect(buildClientValidationEvent({ elements: [] })).toBeNull();
  });
});
