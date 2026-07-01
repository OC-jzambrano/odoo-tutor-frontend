import { describe, expect, it } from "vitest";

import {
  buildSkipStepRequest,
  getVisibleSkipResponse,
} from "../../../odoo_tutor/static/src/core/skip_step.js";

describe("skip step contract", () => {
  it("builds an explicit hidden next action", () => {
    expect(
      buildSkipStepRequest({
        exerciseId: "ex-crm",
        context: { model: "crm.lead" },
      }),
    ).toEqual({
      message: "next",
      context: {
        model: "crm.lead",
        exercise_id: "ex-crm",
        exercise_action: "next",
      },
      payloadExtra: {
        exercise_id: "ex-crm",
        exercise_action: "next",
      },
    });
  });

  it("returns the next instruction for display", () => {
    const result = getVisibleSkipResponse(
      { response: "Enter the expected revenue." },
      (payload) => payload.response,
      () => false,
    );

    expect(result).toBe("Enter the expected revenue.");
  });

  it("does not display duplicate responses", () => {
    const result = getVisibleSkipResponse(
      { response: "Click New." },
      (payload) => payload.response,
      () => true,
    );

    expect(result).toBe("");
  });
});
