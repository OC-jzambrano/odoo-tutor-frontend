/** @odoo-module **/

export function isTicketResponseValid(response, now = Date.now()) {
  return Boolean(
    response?.ticket &&
      Number.isFinite(Number(response.expires_at)) &&
      Number(response.expires_at) * 1000 > now
  );
}

export function createAuthTicketFrame(ticket) {
  if (typeof ticket !== "string" || !ticket) {
    throw new Error("A WebSocket ticket is required");
  }
  return JSON.stringify({ type: "auth_ticket", ticket });
}

export function isAuthenticatedAck(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      ["authenticated", "authentication_success", "auth_success"].includes(data.type) &&
      data.success !== false
  );
}

export function isAuthenticationFailure(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      (["authentication_failed", "auth_failed", "error"].includes(data.type) ||
        data.success === false)
  );
}

export function shouldRetryWithoutStoredSession(data) {
  if (!isAuthenticationFailure(data)) {
    return false;
  }
  const msg = String(data?.message || data?.reason || data?.code || "").toLowerCase();
  return (
    msg.includes("another user") ||
    msg.includes("session") ||
    msg.includes("not found")
  );
}
