from odoo import fields, models

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    @staticmethod
    def _get_param(params, key, default=""):
        record = params.search([("key", "=", key)], limit=1)
        return (record.value if record else None) or default

    @staticmethod
    def _set_param(params, key, value):
        record = params.search([("key", "=", key)], limit=1)
        if record:
            record.write({"value": value or False})
        else:
            params.create({"key": key, "value": value or False})

    odoo_tutor_llm_provider = fields.Selection(
        selection=[
            ("bedrock", "Amazon Bedrock"),
            ("openai", "OpenAI"),
            ("gemini", "Google Gemini"),
            ("anthropic", "Anthropic Claude"),
        ],
        string="AI Provider",
        default="bedrock",
    )
    odoo_tutor_llm_model = fields.Char(string="Model (optional)")
    odoo_tutor_llm_api_key = fields.Char(string="Provider API key", groups="base.group_system")
    odoo_tutor_llm_api_secret = fields.Char(string="AWS secret key", groups="base.group_system")
    odoo_tutor_llm_region = fields.Char(string="AWS region", default="eu-north-1")

    odoo_tutor_openai_key = fields.Char(
        string="OpenAI API Key (BYOK)",
        config_parameter="odoo_tutor.openai_key",
        help="Introduce tu clave sk-... de OpenAI para activar el tutor de IA.",
    )
    odoo_tutor_backend_url = fields.Char(
        string="Odoo Tutor Backend URL",
        config_parameter="odoo_tutor.backend_url",
        default="http://host.docker.internal:8002",
        help="URL interna del backend del tutor; cada usuario aporta su proveedor mediante un ticket de un solo uso.",
    )

    chatbot_ws_base_url = fields.Char(string="WebSocket URL")
    chatbot_api_key = fields.Char(string="API Key")

    def set_values(self):
        res = super().set_values()
        params = self.env["ir.config_parameter"].sudo()
        uid = self.env.user.id
        for name, field_name in (
            ("provider", "odoo_tutor_llm_provider"),
            ("model", "odoo_tutor_llm_model"),
            ("api_key", "odoo_tutor_llm_api_key"),
            ("api_secret", "odoo_tutor_llm_api_secret"),
            ("region", "odoo_tutor_llm_region"),
        ):
            self._set_param(
                params,
                f"odoo_tutor.user.{uid}.{name}",
                (getattr(self, field_name) or "").strip(),
            )
        self._set_param(
            params,
            "odoo_tutor.chatbot_ws_base_url",
            (self.chatbot_ws_base_url or DEFAULT_CHATBOT_WS_BASE_URL).strip(),
        )
        self._set_param(
            params,
            "odoo_tutor.chatbot_api_key",
            (self.chatbot_api_key or "").strip(),
        )
        return res

    def get_values(self):
        res = super().get_values()
        params = self.env["ir.config_parameter"].sudo()
        uid = self.env.user.id
        res.update(
            odoo_tutor_llm_provider=self._get_param(
                params,
                f"odoo_tutor.user.{uid}.provider", "bedrock"
            ),
            odoo_tutor_llm_model=self._get_param(params, f"odoo_tutor.user.{uid}.model"),
            odoo_tutor_llm_api_key=self._get_param(params, f"odoo_tutor.user.{uid}.api_key"),
            odoo_tutor_llm_api_secret=self._get_param(params, f"odoo_tutor.user.{uid}.api_secret"),
            odoo_tutor_llm_region=self._get_param(
                params,
                f"odoo_tutor.user.{uid}.region", "eu-north-1"
            ),
            chatbot_ws_base_url=self._get_param(
                params,
                "odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL
            ),
            chatbot_api_key=self._get_param(
                params,
                "odoo_tutor.chatbot_api_key", ""
            ),
        )
        return res
