"""Validate public Odoo origins and derive the HTTPS service API endpoint."""

import ipaddress
import math
import os
from urllib.parse import urlsplit

_DEV_ENV_VALUES = {"dev", "development", "local"}


def _is_dev_environment():
    return os.getenv("APP_ENV", "prod").strip().lower() in _DEV_ENV_VALUES


def _is_loopback_host(hostname):
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def canonical_https_origin(value):
    """Return a canonical origin, requiring HTTPS in production.

    In explicit local dev mode (``APP_ENV=dev``), loopback HTTP origins such as
    ``http://localhost:8069`` are also accepted.
    """
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
        parsed.scheme not in ("https", "http")
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
    if parsed.scheme == "http" and not (_is_dev_environment() and _is_loopback_host(hostname)):
        raise ValueError("invalid_origin")
    authority = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if parsed.scheme == "https" else 80
    if port not in (None, default_port):
        authority = f"{authority}:{port}"
    return f"{parsed.scheme}://{authority}"


def backend_api_base_from_ws_url(value):
    """Derive the HTTP(S) API origin from a configured WS(S) endpoint.

    Production requires ``wss://``. In explicit local dev mode (``APP_ENV=dev``),
    loopback ``ws://localhost:*`` / ``ws://127.0.0.1:*`` endpoints are also accepted.
    """
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ValueError("invalid_websocket_url")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid_websocket_url") from exc
    hostname = parsed.hostname
    if (
        parsed.scheme not in ("wss", "ws")
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
    if parsed.scheme == "ws" and not (_is_dev_environment() and _is_loopback_host(hostname)):
        raise ValueError("invalid_websocket_url")
    http_scheme = "https" if parsed.scheme == "wss" else "http"
    default_port = 443 if http_scheme == "https" else 80
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port not in (None, default_port):
        authority = f"{authority}:{port}"
    return f"{http_scheme}://{authority}"


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
