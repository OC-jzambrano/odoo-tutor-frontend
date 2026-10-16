import json
import os

import requests

from odoo import http
from odoo.http import request

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL
from .ai.ai_bot import AiBot


class AiChatController(http.Controller):
    @staticmethod
    def _env_flag(name, default=False):
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    def _get_ws_base_url(self):
        ws_base_url = (
            request.env["ir.config_parameter"]
            .sudo()
            .get_param("odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL)
        )
        return (ws_base_url or "").strip() or DEFAULT_CHATBOT_WS_BASE_URL

    @http.route("/ai_chat/ws_config", type="jsonrpc", auth="user")
    def ws_config(self, **kwargs):
        return {
            "ws_base_url": self._get_ws_base_url(),
            "enable_skip_step": self._env_flag("ODOO_TUTOR_ENABLE_SKIP_STEP"),
        }

    @http.route("/ai_chat/chat", type="jsonrpc", auth="user", methods=["POST"])
    def get_quickboard_item(
        self, message=None, context=None, history=None, ws_session_id=None, **kwargs
    ):
        """Endpoint principal para el chatbot AI"""
        data = {}
        if hasattr(request, "httprequest") and getattr(
            request.httprequest, "data", None
        ):
            try:
                raw_data = request.httprequest.data
                if isinstance(raw_data, bytes):
                    raw_data = raw_data.decode("utf-8")
                data = json.loads(raw_data or "{}")
            except Exception:
                data = {}
        params_body = data.get("params", {}) if isinstance(data, dict) else {}

        ws_session_id = (
            ws_session_id
            or kwargs.get("ws_session_id")
            or params_body.get("ws_session_id")
            or (data.get("ws_session_id") if isinstance(data, dict) else None)
        )
        message = (
            message
            or kwargs.get("message")
            or params_body.get("message")
            or (data.get("message") if isinstance(data, dict) else None)
        )
        context = (
            context
            if context is not None
            else kwargs.get(
                "context",
                params_body.get(
                    "context",
                    (data.get("context", {}) if isinstance(data, dict) else {}),
                ),
            )
        )
        history = (
            history
            if history is not None
            else kwargs.get(
                "history",
                params_body.get(
                    "history",
                    (data.get("history", []) if isinstance(data, dict) else []),
                ),
            )
        )

        bot = AiBot(request.env, ws_session_id=ws_session_id)

        try:
            # Validación del mensaje
            if not message or not isinstance(message, str):
                raise ValueError("El parámetro 'message' es requerido y debe ser texto")

            return bot._chat(message=message, context=context)

        except Exception as e:
            return f"Error: {e}"

    @http.route("/ai_chat/validate_exercise", type="jsonrpc", auth="user")
    def validate_exercise(self, exercise_id=None, **kwargs):
        if not exercise_id:
            exercise_id = kwargs.get("exercise_id")

        if (
            not exercise_id
            and hasattr(http.request, "httprequest")
            and getattr(http.request.httprequest, "data", None)
        ):
            try:
                raw_data = http.request.httprequest.data
                if isinstance(raw_data, bytes):
                    raw_data = raw_data.decode("utf-8")
                data = json.loads(raw_data or "{}")
                if isinstance(data, dict):
                    exercise_id = data.get("params", {}).get("exercise_id") or data.get(
                        "exercise_id"
                    )
            except Exception:
                pass

        if not exercise_id:
            return {"error": "Missing exercise_id"}

        config_params = request.env["ir.config_parameter"].sudo()

        session_token = config_params.get_param("odoo_tutor.chatbot_session_token", "0")

        base_url = config_params.get_param(
            "odoo_tutor.chatbot_base_url", "http://0.0.0.0:8001"
        )

        url = base_url + "/validate_exercise"

        params = {
            "exercise_id": exercise_id,
            "session_token": session_token,
            "user_login": "admin",
            "db": http.request.env.cr.dbname,
        }

        try:
            response = requests.get(url, params=params, timeout=10)
            return {"result": response.text}
        except Exception as e:
            return {"error": str(e)}

    @http.route("/ai_chat/feedback", type="jsonrpc", auth="user")
    def ai_chat_feedback(
        self,
        message_uid=None,
        vote=None,
        comment=None,
        context=None,
        message_body_html=None,
        message_body_text=None,
        **kw,
    ):
        env = request.env
        vals = {
            "user_id": env.user.id,
            "message_uid": message_uid,
            "vote": vote,
            "comment": comment,
            "context_model": (context or {}).get("model"),
            "context_res_id": (context or {}).get("res_id"),
            "context_json": context or {},
            "message_body_html": message_body_html,
            "message_body_text": message_body_text,
        }
        rec = env["ai.chat.feedback"].sudo().create(vals)
        return {"id": rec.id}
