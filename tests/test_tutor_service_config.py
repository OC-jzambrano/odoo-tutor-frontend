"""Security regression tests for the addon service URL contract."""

import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = (
    Path(__file__).parents[1]
    / "odoo_tutor"
    / "services"
    / "tutor_service_config.py"
)
SPEC = importlib.util.spec_from_file_location("tutor_service_config", MODULE_PATH)
CONFIG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONFIG)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://odoo.example.com", "https://odoo.example.com"),
        ("https://ODOO.example.com/", "https://odoo.example.com"),
        ("https://odoo.example.com:8443", "https://odoo.example.com:8443"),
    ],
)
def test_canonicalizes_https_origins(value, expected):
    assert CONFIG.canonical_https_origin(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "http://odoo.example.com",
        "https://*.example.com",
        "https://user:password@odoo.example.com",
        "https://odoo.example.com/path",
        "https://odoo.example.com/?next=evil",
        "https://odoo.example.com#fragment",
        "https://odoo.example.com\\@evil.example",
        " https://odoo.example.com",
        "https://",
    ],
)
def test_rejects_noncanonical_or_unsafe_origins(value):
    with pytest.raises(ValueError):
        CONFIG.canonical_https_origin(value)


def test_derives_https_api_origin_without_forwarding_websocket_path():
    assert (
        CONFIG.backend_api_base_from_ws_url("wss://tutor.example.com:8443/ws")
        == "https://tutor.example.com:8443"
    )


@pytest.mark.parametrize(
    "value",
    [
        "ws://tutor.example.com/ws",
        "wss://user:secret@tutor.example.com/ws",
        "wss://tutor.example.com/ws?redirect=evil",
        "wss://*.example.com/ws",
    ],
)
def test_rejects_unsafe_websocket_urls(value):
    with pytest.raises(ValueError):
        CONFIG.backend_api_base_from_ws_url(value)


def test_activation_response_requires_object_matching_installation_and_secret():
    installation_id = "6a3fd1d9-9a0d-48bf-b2b3-95b92a481e19"
    credential = "x" * 48
    assert CONFIG.parse_activation_response(
        {"installation_id": installation_id, "installation_credential": credential},
        installation_id,
    ) == credential
    for body in (
        [],
        {"installation_id": "another-installation", "installation_credential": credential},
        {"installation_id": installation_id, "installation_credential": "short"},
    ):
        with pytest.raises(ValueError):
            CONFIG.parse_activation_response(body, installation_id)


def test_ticket_response_rejects_array_expired_or_boolean_expiry():
    valid = {"ticket": "one-use", "expires_at": 101}
    assert CONFIG.parse_ticket_response(valid, 100) == ("one-use", 101)
    for body in (
        [],
        {"ticket": "expired", "expires_at": 99},
        {"ticket": "bad-expiry", "expires_at": True},
        {"ticket": "missing-expiry"},
    ):
        with pytest.raises(ValueError):
            CONFIG.parse_ticket_response(body, 100)


def test_activation_attempts_use_a_rolling_window_and_reject_malformed_state():
    assert CONFIG.recent_activation_attempts(
        [900, 950, "bad", True, 700], 1000, 200
    ) == [900, 950]
    assert CONFIG.recent_activation_attempts({"unexpected": 1}, 1000, 200) == []
