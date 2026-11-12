"""Regression checks for customer settings and browser credential boundaries."""

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_settings_keep_public_configuration_but_remove_shared_service_key():
    view = (ROOT / "odoo_mentor/views/res_config_settings_views.xml").read_text()
    model = (ROOT / "odoo_mentor/models/res_config_settings.py").read_text()

    assert 'string="Installation ID"' in view
    assert 'string="Service status"' in view
    assert 'string="WebSocket URL"' in view
    assert "Tutor Service API Key" not in view
    assert 'name="chatbot_api_key"' not in view
    assert "chatbot_api_key = fields." not in model
    assert 'params.set_str("odoo_tutor.chatbot_api_key", "")' in model
    assert "installation_credential" not in model


def test_browser_configuration_and_ticket_responses_do_not_return_install_credential():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text()
    config_route = controller.split("def ws_config", 1)[1].split("@http.route", 1)[0]
    ticket_route = controller.split("def ws_ticket", 1)[1].split("@http.route", 1)[0]

    assert "installation_credential" not in config_route
    assert 'return {"ticket": ticket, "expires_at": expires_at}' in ticket_route
    assert 'return {"installation_credential"' not in ticket_route
    assert 'headers={"Authorization": "Bearer " + credential}' in ticket_route


def test_shared_service_key_is_not_used_by_server_endpoints():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text()
    ai_bot = (ROOT / "odoo_mentor/controllers/ai/ai_bot.py").read_text()

    assert 'get_str("odoo_tutor.chatbot_api_key"' not in controller
    assert "X-API-Key" not in controller
    assert "chatbot_api_key" not in ai_bot
    assert "X-API-KEY" not in ai_bot
