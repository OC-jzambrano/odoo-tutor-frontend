"""Validate public Odoo origins and derive the HTTPS service API endpoint."""

import math
from urllib.parse import urlsplit


def canonical_https_origin(value):
    """Return a canonical HTTPS origin, rejecting paths and wildcard hosts."""
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ValueError("invalid_origin")
    if value != value.strip() or "*" in value or "\\" in value:
        raise ValueError("invalid_origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid_origin") from exc
    hostname = parsed.hostname
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_origin")
    try:
        hostname = hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError("invalid_origin") from exc
    if any(not label or len(label) > 63 for label in hostname.rstrip(".").split(".")):
        raise ValueError("invalid_origin")
    hostname = hostname.rstrip(".")
    if not hostname or hostname.startswith("."):
        raise ValueError("invalid_origin")
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port not in (None, 443):
        authority = f"{authority}:{port}"
    return f"https://{authority}"


def backend_api_base_from_ws_url(value):
    """Derive the HTTPS API origin from a configured WSS endpoint."""
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ValueError("invalid_websocket_url")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid_websocket_url") from exc
    hostname = parsed.hostname
    if (
        parsed.scheme != "wss"
        or not hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or "*" in value
        or "\\" in value
    ):
        raise ValueError("invalid_websocket_url")
    hostname = hostname.encode("idna").decode("ascii").lower()
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port not in (None, 443):
        authority = f"{authority}:{port}"
    return f"https://{authority}"


def parse_activation_response(body, expected_installation_id):
    """Validate backend activation output before persisting its credential."""
    if not isinstance(body, dict):
        raise ValueError("invalid_activation_response")
    credential = body.get("installation_credential")
    if (
        body.get("installation_id") != expected_installation_id
        or not isinstance(credential, str)
        or not 32 <= len(credential) <= 4096
        or any(ord(char) < 32 for char in credential)
    ):
        raise ValueError("invalid_activation_response")
    return credential


def parse_ticket_response(body, now):
    """Validate a short-lived ticket response without accepting arrays or booleans."""
    if not isinstance(body, dict):
        raise ValueError("invalid_ticket_response")
    ticket = body.get("ticket")
    expires_at = body.get("expires_at")
    if (
        not isinstance(ticket, str)
        or not ticket
        or len(ticket) > 4096
        or type(expires_at) not in (int, float)
        or not math.isfinite(expires_at)
        or expires_at <= now
    ):
        raise ValueError("invalid_ticket_response")
    return ticket, expires_at


def recent_activation_attempts(previous, now, window_seconds):
    """Filter persisted activation timestamps to a rolling time window."""
    if not isinstance(previous, list):
        return []
    return [
        attempt
        for attempt in previous
        if type(attempt) is int and 0 <= now - attempt < window_seconds
    ]
