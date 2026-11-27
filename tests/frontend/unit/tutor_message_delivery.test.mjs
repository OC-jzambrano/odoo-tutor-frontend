import { describe, expect, it } from "vitest";

import {
  buildTutorStepKey,
  isDuplicateTutorAssistantMessage,
  shouldQueueTutorMessage,
} from "../../../odoo_mentor/static/src/core/tutor_message_delivery.js";

describe("tutor message delivery ordering", () => {
  it("queues when the chat has not been created yet", () => {
    expect(
      shouldQueueTutorMessage({ aiChat: null, isSidebarOpen: true }),
    ).toBe(true);
  });

  it("queues when the sidebar is closed, even if the chat exists", () => {
    expect(
      shouldQueueTutorMessage({ aiChat: {}, isSidebarOpen: false }),
    ).toBe(true);
  });

  it("pushes directly only when the chat exists and the sidebar is open", () => {
    expect(
      shouldQueueTutorMessage({ aiChat: {}, isSidebarOpen: true }),
    ).toBe(false);
  });

  it("allows repeated step instructions when advancing to a new step index (e.g. second RFQ)", () => {
    const step14 = buildTutorStepKey({ exercise_id: "ex-rfq", current_step: 14 });
    const step15 = buildTutorStepKey({ exercise_id: "ex-rfq", current_step: 15 });
    expect(step14).toBe("ex-rfq:14");
    expect(step15).toBe("ex-rfq:15");

    // Same text as an earlier step, but different stepKey => NOT a duplicate
    expect(
      isDuplicateTutorAssistantMessage({
        normalizedText: "update vendor",
        stepKey: step14,
        lastInjectedText: "click new",
        lastInjectedAt: 1000,
        lastInjectedStepKey: "ex-rfq:13",
        lastDomText: "click back to requests for quotation",
        now: 2000,
      }),
    ).toBe(false);

    // Even consecutive steps with identical text but different stepKey => NOT a duplicate
    expect(
      isDuplicateTutorAssistantMessage({
        normalizedText: "click save",
        stepKey: step15,
        lastInjectedText: "click save",
        lastInjectedAt: 1000,
        lastInjectedStepKey: step14,
        lastDomText: "click save",
        now: 1500,
      }),
    ).toBe(false);

    // Same stepKey + same text => duplicate delivery IS suppressed
    expect(
      isDuplicateTutorAssistantMessage({
        normalizedText: "select vendor",
        stepKey: step15,
        lastInjectedText: "select vendor",
        lastInjectedAt: 1000,
        lastInjectedStepKey: step15,
        lastDomText: "select vendor",
        now: 1500,
      }),
    ).toBe(true);
  });

  it("suppresses immediate non-step echoes while allowing earlier repeated text", () => {
    expect(
      isDuplicateTutorAssistantMessage({
        normalizedText: "update vendor",
        lastInjectedText: "click back to requests for quotation",
        lastInjectedAt: 1000,
        lastDomText: "click back to requests for quotation",
        now: 2000,
      }),
    ).toBe(false);

    expect(
      isDuplicateTutorAssistantMessage({
        normalizedText: "do you want to start this exercise?",
        lastInjectedText: "do you want to start this exercise?",
        lastInjectedAt: 1000,
        lastDomText: "do you want to start this exercise?",
        now: 2500,
      }),
    ).toBe(true);
  });
});
