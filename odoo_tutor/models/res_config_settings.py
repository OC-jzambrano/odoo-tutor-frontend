from odoo import fields, models
import uuid

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    chatbot_ws_base_url = fields.Char(string="WebSocket URL")
    chatbot_api_key = fields.Char(string="API Key")
    chatbot_installation_id = fields.Char(string="Installation ID")

    def set_values(self):
        res = super().set_values()
        self.env["ir.config_parameter"].sudo().set_str(
            "odoo_tutor.chatbot_ws_base_url",
            (self.chatbot_ws_base_url or DEFAULT_CHATBOT_WS_BASE_URL).strip(),
        )
        self.env["ir.config_parameter"].sudo().set_str(
            "odoo_tutor.chatbot_api_key",
            self.chatbot_api_key or "your_super_secret_key_123",
        )
        params = self.env["ir.config_parameter"].sudo()
        if self.chatbot_installation_id:
            params.set_str("odoo_tutor.installation_id", self.chatbot_installation_id)
        return res

    def get_values(self):
        res = super().get_values()
        params = self.env["ir.config_parameter"].sudo()
        installation_id = params.get_str("odoo_tutor.installation_id", "")
        if not installation_id:
            installation_id = str(uuid.uuid4())
            params.set_str("odoo_tutor.installation_id", installation_id)
        res.update(
            chatbot_ws_base_url=params.get_str(
                "odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL
            ),
            chatbot_api_key=params.get_str(
                "odoo_tutor.chatbot_api_key", "your_super_secret_key_123"
            ),
            chatbot_installation_id=installation_id,
        )
        return res
