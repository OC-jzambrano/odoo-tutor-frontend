import { describe, expect, test } from "vitest";

import { isBrowserPushRegistrationError } from "../../../odoo_mentor/static/src/core/push_error";

describe("isBrowserPushRegistrationError", () => {
  test("matches the AbortError raised by browser push service registration", () => {
    expect(
      isBrowserPushRegistrationError(
        new DOMException("Registration failed - push service error", "AbortError")
      )
    ).toBe(true);
  });

  test("matches service worker registration fallback errors", () => {
    expect(isBrowserPushRegistrationError(new Error("ServiceWorkerRegistration error"))).toBe(true);
  });

  test("does not match unrelated Odoo or programming errors", () => {
    expect(isBrowserPushRegistrationError(new Error("Access denied"))).toBe(false);
    expect(isBrowserPushRegistrationError(new TypeError("Cannot read properties of undefined"))).toBe(
      false
    );
  });
});
