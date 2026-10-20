from odoo import fields, models


class ResUsers(models.Model):
    _inherit = "res.users"

    tutor_llm_provider = fields.Selection(
        selection=[
            ("bedrock", "Amazon Bedrock"),
            ("openai", "OpenAI"),
            ("gemini", "Google Gemini"),
            ("anthropic", "Anthropic Claude"),
        ],
        string="AI provider",
        compute="_compute_tutor_llm_config",
        inverse="_inverse_tutor_llm_config",
    )
    tutor_llm_model = fields.Char(
        string="Model (optional)",
        compute="_compute_tutor_llm_config",
        inverse="_inverse_tutor_llm_config",
    )
    tutor_llm_api_key = fields.Char(
        string="Provider API key",
        compute="_compute_tutor_llm_config",
        inverse="_inverse_tutor_llm_config",
    )
    tutor_llm_api_secret = fields.Char(
        string="AWS secret key",
        compute="_compute_tutor_llm_config",
        inverse="_inverse_tutor_llm_config",
    )
    tutor_llm_region = fields.Char(
        string="AWS region",
        compute="_compute_tutor_llm_config",
        inverse="_inverse_tutor_llm_config",
    )

    def _compute_tutor_llm_config(self):
        params = self.env["ir.config_parameter"].sudo()
        uid = self.env.uid
        values = {
            "tutor_llm_provider": "bedrock",
            "tutor_llm_model": "",
            "tutor_llm_api_key": "",
            "tutor_llm_api_secret": "",
            "tutor_llm_region": "eu-north-1",
        }
        for name, default in (("provider", "bedrock"), ("model", ""), ("api_key", ""), ("api_secret", ""), ("region", "eu-north-1")):
            record = params.search([("key", "=", f"odoo_tutor.user.{uid}.{name}")], limit=1)
            values[f"tutor_llm_{name}"] = (record.value if record else None) or default
        for user in self:
            user.tutor_llm_provider = values["tutor_llm_provider"]
            user.tutor_llm_model = values["tutor_llm_model"]
            user.tutor_llm_api_key = values["tutor_llm_api_key"]
            user.tutor_llm_api_secret = values["tutor_llm_api_secret"]
            user.tutor_llm_region = values["tutor_llm_region"]

    def _inverse_tutor_llm_config(self):
        params = self.env["ir.config_parameter"].sudo()
        uid = self.env.uid
        user = self.env.user
        values = {
            "provider": user.tutor_llm_provider or "bedrock",
            "model": user.tutor_llm_model or "",
            "api_key": user.tutor_llm_api_key or "",
            "api_secret": user.tutor_llm_api_secret or "",
            "region": user.tutor_llm_region or "eu-north-1",
        }
        for name, value in values.items():
            key = f"odoo_tutor.user.{uid}.{name}"
            record = params.search([("key", "=", key)], limit=1)
            if record:
                record.write({"value": value})
            else:
                params.create({"key": key, "value": value})
