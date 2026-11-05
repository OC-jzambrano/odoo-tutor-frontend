import { describe, expect, it } from "vitest";
import {
  createAuthTicketFrame,
  isAuthenticatedAck,
  isAuthenticationFailure,
  isTicketResponseValid,
} from "../../../odoo_tutor/static/src/core/ws_ticket_protocol.js";

describe("WebSocket ticket protocol", () => {
  it("accepts a ticket only while its server expiry is in the future", () => {
    expect(isTicketResponseValid({ ticket: "one-use", expires_at: 101 }, 100_000)).toBe(true);
    expect(isTicketResponseValid({ ticket: "expired", expires_at: 100 }, 100_000)).toBe(false);
    expect(isTicketResponseValid({ ticket: "missing-expiry" }, 100_000)).toBe(false);
    expect(isTicketResponseValid({ expires_at: 101 }, 100_000)).toBe(false);
  });

  it("formats the ticket as the first-frame authentication envelope", () => {
    expect(JSON.parse(createAuthTicketFrame("fresh-ticket"))).toEqual({
      type: "auth_ticket",
      ticket: "fresh-ticket",
    });
    expect(() => createAuthTicketFrame("")).toThrow("ticket is required");
  });

  it("only treats a positive authentication acknowledgement as authenticated", () => {
    expect(isAuthenticatedAck({ type: "authenticated", success: true })).toBe(true);
    expect(isAuthenticatedAck({ type: "auth_success" })).toBe(true);
    expect(isAuthenticatedAck({ type: "authenticated", success: false })).toBe(false);
    expect(isAuthenticatedAck({ type: "connection_established" })).toBe(false);
    expect(isAuthenticationFailure({ type: "authentication_failed", success: false })).toBe(true);
    expect(isAuthenticationFailure({ type: "error" })).toBe(true);
  });
});
