import { describe, expect, it } from "vitest";

import { shouldQueueTutorMessage } from "../../../odoo_tutor/static/src/core/tutor_message_delivery.js";

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
});
