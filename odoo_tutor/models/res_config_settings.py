from odoo import fields, models

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    chatbot_ws_base_url = fields.Char(string="WebSocket URL")
    chatbot_api_key = fields.Char(string="API Key")

    def set_values(self):
        res = super().set_values()
        self.env["ir.config_parameter"].sudo().set_param(
            "odoo_tutor.chatbot_ws_base_url",
            (self.chatbot_ws_base_url or DEFAULT_CHATBOT_WS_BASE_URL).strip(),
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "odoo_tutor.chatbot_api_key",
            self.chatbot_api_key or "your_super_secret_key_123",
        )
        return res

    def get_values(self):
        res = super().get_values()
        params = self.env["ir.config_parameter"].sudo()
        res.update(
            chatbot_ws_base_url=params.get_param(
                "odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL
            ),
            chatbot_api_key=params.get_param(
                "odoo_tutor.chatbot_api_key", "your_super_secret_key_123"
            ),
        )
        return res
