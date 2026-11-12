import uuid
from odoo import api, fields, models

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    chatbot_ws_base_url = fields.Char(string="WebSocket URL", groups="base.group_system")
    chatbot_installation_id = fields.Char(
        string="Installation ID", readonly=True, groups="base.group_system"
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
        # Remove the retired shared key during module initialization as well as
        # when settings are saved, so upgrades do not leave it stored server-side.
        params.set_str("odoo_tutor.chatbot_api_key", "")
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
            chatbot_installation_id=params.get_str("odoo_tutor.installation_id", ""),
            chatbot_activation_status=params.get_str("odoo_tutor.activation_status", "inactive"),
            chatbot_llm_provider=params.get_str("odoo_tutor.llm_provider", "openai"),
            # Keep the provider key server-side; a blank password input preserves its stored value.
            chatbot_llm_api_key="",
        )
        return res
