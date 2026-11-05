"""Helpers for signing short-lived Odoo Tutor WebSocket tickets."""

import base64
import hashlib
import hmac
import json
import secrets
import time

TICKET_TTL_SECONDS = 60


def build_ws_ticket_claims(uid, login, db, tenant, *, now=None):
    issued_at = int(time.time()) if now is None else int(now)
    return {
        "sub": str(uid),
        "login": login or "",
        "db": db,
        "tenant": tenant,
        "jti": secrets.token_urlsafe(24),
        "iat": issued_at,
        "exp": issued_at + TICKET_TTL_SECONDS,
        "aud": "odoo-tutor-ws",
    }


def _encode_segment(value):
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=").decode("ascii")


def sign_ws_ticket(claims, signing_secret):
    """Return a compact payload.signature ticket for the tenant verifier."""
    encoded_claims = _encode_segment(claims)
    signature = hmac.new(
        signing_secret.encode("utf-8"), encoded_claims.encode("ascii"), hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{encoded_claims}.{encoded_signature}"
