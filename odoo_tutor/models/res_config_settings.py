import uuid
import json
import time

import requests
from odoo import _, api, fields, models
from odoo.exceptions import UserError

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL
from ..services.tutor_service_config import (
    backend_api_base_from_ws_url,
    canonical_https_origin,
    parse_activation_response,
    recent_activation_attempts,
)

ACTIVATION_WINDOW_SECONDS = 15 * 60
ACTIVATION_MAX_ATTEMPTS = 5


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    chatbot_ws_base_url = fields.Char(string="WebSocket URL", groups="base.group_system")
    chatbot_api_key = fields.Char(
        string="Tutor Service API Key", password=True, groups="base.group_system"
    )
    chatbot_installation_id = fields.Char(
        string="Installation ID", readonly=True, groups="base.group_system"
    )
    chatbot_activation_code = fields.Char(
        string="Activation code", password=True, groups="base.group_system"
    )
    chatbot_activation_status = fields.Selection(
        [("inactive", "Not activated"), ("active", "Active"), ("revoked", "Revoked")],
        string="Activation status", readonly=True, groups="base.group_system",
    )
    chatbot_llm_provider = fields.Selection(
        [("openai", "OpenAI"), ("anthropic", "Claude (Anthropic)"),
         ("google", "Gemini (Google)")],
        string="Provider", groups="base.group_system",
    )
    chatbot_llm_api_key = fields.Char(string="LLM API Key", groups="base.group_system")

    @api.model
    def _ensure_installation_identity(self):
        """Create stable per-database settings as soon as the addon is used."""
        params = self.env["ir.config_parameter"].sudo()
        if not params.get_str("odoo_tutor.installation_id", ""):
            params.set_str("odoo_tutor.installation_id", str(uuid.uuid4()))
        if not params.get_str("odoo_tutor.chatbot_ws_base_url", ""):
            params.set_str("odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL)

    @api.model
    def _register_hook(self):
        result = super()._register_hook()
        self._ensure_installation_identity()
        return result

    def set_values(self):
        res = super().set_values()
        params = self.env["ir.config_parameter"].sudo()
        params.set_str(
            "odoo_tutor.chatbot_ws_base_url",
            (self.chatbot_ws_base_url or DEFAULT_CHATBOT_WS_BASE_URL).strip(),
        )
        if self.chatbot_api_key:
            params.set_str("odoo_tutor.chatbot_api_key", self.chatbot_api_key)
        params.set_str("odoo_tutor.llm_provider", self.chatbot_llm_provider or "openai")
        if self.chatbot_llm_api_key:
            params.set_str("odoo_tutor.llm_api_key", self.chatbot_llm_api_key)
        return res

    def get_values(self):
        self._ensure_installation_identity()
        res = super().get_values()
        params = self.env["ir.config_parameter"].sudo()
        res.update(
            chatbot_ws_base_url=params.get_str("odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL),
            # Never echo server credentials into the settings form response.
            chatbot_api_key="",
            chatbot_activation_code="",
            chatbot_installation_id=params.get_str("odoo_tutor.installation_id", ""),
            chatbot_activation_status=params.get_str("odoo_tutor.activation_status", "inactive"),
            chatbot_llm_provider=params.get_str("odoo_tutor.llm_provider", "openai"),
            # Keep the provider key server-side; a blank password input preserves its stored value.
            chatbot_llm_api_key="",
        )
        return res

    def action_activate_tutor(self):
        self.ensure_one()
        if not self.env.user.has_group("base.group_system"):
            raise UserError(_("Only an administrator can activate the tutor service."))
        params = self.env["ir.config_parameter"].sudo()
        # The settings form may contain unsaved values when this button runs.
        ws_url = (self.chatbot_ws_base_url or DEFAULT_CHATBOT_WS_BASE_URL).strip()
        params.set_str("odoo_tutor.chatbot_ws_base_url", ws_url)
        try:
            origin = canonical_https_origin(params.get_str("web.base.url", ""))
            api_base = backend_api_base_from_ws_url(ws_url)
        except (TypeError, ValueError, UnicodeError):
            return self._activation_notice(
                _("Set a valid public HTTPS URL and a valid wss:// service URL first."),
                "warning",
            )

        activation_code = (self.chatbot_activation_code or "").strip()
        if not activation_code:
            return self._activation_notice(
                _("Enter the activation code or link a license before activating."),
                "warning",
            )

        # Serialize attempts across Odoo workers and persist the counter even
        # when the remote activation fails. The client action commits normally.
        self.env.cr.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))",
            ("odoo_tutor_activation_rate_limit",),
        )
        now = int(time.time())
        try:
            previous = json.loads(
                params.get_str("odoo_tutor.activation_attempts", "[]")
            )
        except (TypeError, ValueError):
            previous = []
        attempts = recent_activation_attempts(
            previous, now, ACTIVATION_WINDOW_SECONDS
        )
        if len(attempts) >= ACTIVATION_MAX_ATTEMPTS:
            return self._activation_notice(
                _("Too many activation attempts. Please wait 15 minutes and try again."),
                "warning",
            )
        attempts.append(now)
        params.set_str("odoo_tutor.activation_attempts", json.dumps(attempts))

        installation_id = params.get_str("odoo_tutor.installation_id", "")
        if not installation_id:
            installation_id = str(uuid.uuid4())
            params.set_str("odoo_tutor.installation_id", installation_id)
        try:
            response = requests.post(
                api_base + "/odoo/activate",
                json={"installation_id": installation_id, "origin": origin, "addon_version": "20.0.1.0.2"},
                headers={"Authorization": "Bearer " + activation_code},
                timeout=(3, 10),
                allow_redirects=False,
            )
            if response.status_code != 200:
                raise ValueError("backend_status")
            credential = parse_activation_response(response.json(), installation_id)
        except (requests.RequestException, ValueError, TypeError):
            params.set_str("odoo_tutor.activation_status", "inactive")
            # Store only a non-sensitive category; never include HTTP body or credentials.
            params.set_str("odoo_tutor.activation_error", "activation_failed")
            return self._activation_notice(
                _("Activation failed. Check the activation code and service availability."),
                "danger",
            )
        params.set_str("odoo_tutor.installation_credential", credential)
        params.set_str("odoo_tutor.activation_status", "active")
        params.set_str("odoo_tutor.activation_error", "")
        params.set_str("odoo_tutor.activation_attempts", "[]")
        self.chatbot_activation_code = False
        return self._activation_notice(_("Tutor service activated."), "success")

    @staticmethod
    def _activation_notice(message, notification_type):
        """Return feedback without raising and rolling back persisted retries."""
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Odoo Tutor"),
                "message": message,
                "type": notification_type,
                "sticky": notification_type != "success",
                "next": {"type": "ir.actions.client", "tag": "reload"},
            },
        }
