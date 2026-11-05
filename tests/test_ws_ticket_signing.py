import base64
import hashlib
import hmac
import importlib.util
import json
import secrets
import unittest
from pathlib import Path

_SIGNING_PATH = (
    Path(__file__).resolve().parents[1]
    / "odoo_tutor"
    / "controllers"
    / "ticket_signing.py"
)
_SPEC = importlib.util.spec_from_file_location("ticket_signing", _SIGNING_PATH)
_SIGNING = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_SIGNING)
build_ws_ticket_claims = _SIGNING.build_ws_ticket_claims
sign_ws_ticket = _SIGNING.sign_ws_ticket


class WebSocketTicketSigningTests(unittest.TestCase):
    def setUp(self):
        self.signing_secret = secrets.token_urlsafe(48)

    def _decode(self, value):
        return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))

    def test_ticket_contains_signed_identity_and_fresh_jti(self):
        claims = build_ws_ticket_claims(42, "learner", "school", "installation-uuid", now=100)
        token = sign_ws_ticket(claims, self.signing_secret)
        claims_part, signature_part = token.split(".")
        self.assertEqual(self._decode(claims_part), claims)
        signature = base64.urlsafe_b64decode(
            signature_part + "=" * (-len(signature_part) % 4)
        )
        expected_signature = hmac.new(
            self.signing_secret.encode("utf-8"),
            claims_part.encode("ascii"),
            hashlib.sha256,
        ).digest()
        self.assertTrue(hmac.compare_digest(signature, expected_signature))
        self.assertEqual(claims["sub"], "42")
        self.assertEqual(claims["tenant"], "installation-uuid")
        self.assertEqual(claims["aud"], "odoo-tutor-ws")
        self.assertEqual(claims["exp"], 160)

    def test_each_ticket_gets_a_distinct_id(self):
        one = build_ws_ticket_claims(42, "learner", "school", "install-1", now=100)
        two = build_ws_ticket_claims(42, "learner", "school", "install-1", now=100)
        self.assertNotEqual(one["jti"], two["jti"])
        self.assertGreaterEqual(len(one["jti"]), 22)

    def test_ticket_does_not_include_signing_secret(self):
        token = sign_ws_ticket({"sub": "42", "jti": "one"}, self.signing_secret)
        self.assertNotIn(self.signing_secret, token)


if __name__ == "__main__":
    unittest.main()
