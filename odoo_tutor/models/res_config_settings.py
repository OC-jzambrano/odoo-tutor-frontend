from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    chatbot_base_url = fields.Char(string="API URL")
    chatbot_api_key = fields.Char(string="API Key")
    chatbot_session_token = fields.Char(string="Session Token")

    def set_values(self):
        res = super().set_values()
        self.env["ir.config_parameter"].sudo().set_param(
            "odoo_tutor.chatbot_base_url",
            self.chatbot_base_url or "http://0.0.0.0:8001/chat",
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "odoo_tutor.chatbot_api_key",
            self.chatbot_api_key or "your_super_secret_key_123",
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "odoo_tutor.chatbot_session_token", self.chatbot_session_token
        )
        return res

    def get_values(self):
        res = super().get_values()
        params = self.env["ir.config_parameter"].sudo()
        res.update(
            chatbot_base_url=params.get_param(
                "odoo_tutor.chatbot_base_url", "http://0.0.0.0:8001/chat"
            ),
            chatbot_api_key=params.get_param(
                "odoo_tutor.chatbot_api_key", "your_super_secret_key_123"
            ),
            chatbot_session_token=params.get_param(
                "odoo_tutor.chatbot_session_token"
            ),
        )
        return res
