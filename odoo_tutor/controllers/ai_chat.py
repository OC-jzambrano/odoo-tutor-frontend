import json
import os
import requests
from urllib.parse import urlsplit, urlunsplit
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
            .get_str("odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL)
        )
        return (ws_base_url or "").strip() or DEFAULT_CHATBOT_WS_BASE_URL

    @http.route("/ai_chat/ws_config", type="jsonrpc", auth="user")
    def ws_config(self, **kwargs):
        return {
            "ws_base_url": self._get_ws_base_url(),
            "enable_skip_step": self._env_flag("ODOO_TUTOR_ENABLE_SKIP_STEP"),
        }

    @http.route("/ai_chat/session/<string:session_id>/messages", type="jsonrpc", auth="user")
    def session_messages(self, session_id, **kwargs):
        """Proxy a user's transcript request with backend credentials kept server-side."""
        config_params = request.env["ir.config_parameter"].sudo()
        ws_url = self._get_ws_base_url()
        parsed = urlsplit(ws_url)
        host = parsed.hostname or "localhost"
        if host in {"localhost", "127.0.0.1"}:
            host = "host.docker.internal"
        scheme = "https" if parsed.scheme == "wss" else "http"
        port = parsed.port
        base_url = urlunsplit((scheme, f"{host}:{port}" if port else host, "", "", ""))
        api_key = config_params.get_str("odoo_tutor.chatbot_api_key", "")
        try:
            response = requests.get(
                f"{base_url}/session/{session_id}/messages",
                params={"user_login": request.env.user.login, "db": request.env.cr.dbname},
                headers={"X-API-Key": api_key},
                timeout=10,
            )
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            return {"error": str(exc), "session_id": session_id, "messages": []}

    @http.route("/ai_chat/chat", type="jsonrpc", auth="user", methods=["POST"])
    def get_quickboard_item(self, **kwargs):
        """Endpoint principal para el chatbot AI"""
        data = json.loads(request.httprequest.data or "{}")
        ws_session_id = data.get("ws_session_id")

        bot = AiBot(request.env, ws_session_id=ws_session_id)

        try:
            # Obtener datos del cuerpo de la solicitud
            if request.httprequest.data:
                data = json.loads(request.httprequest.data)
            else:
                raise ValueError("Body is empty")

            message = data.get("message")
            context = data.get("context", {})
            history = data.get("history", [])

            # Validación del mensaje
            if not message or not isinstance(message, str):
                raise ValueError("El parámetro 'message' es requerido y debe ser texto")

            return bot._chat(
                message=message, context=context
            )

        except Exception as e:
            return f"Error: {e}"

    @http.route('/ai_chat/validate_exercise', type='jsonrpc', auth='user')
    def validate_exercise(self, exercise_id=None, **kwargs):

        if not exercise_id:
            return {"error": "Missing exercise_id"}

        config_params = request.env['ir.config_parameter'].sudo()

        session_token = config_params.get_str(
            "odoo_tutor.chatbot_session_token",
            "0"
        )

        base_url = config_params.get_str(
            "odoo_tutor.chatbot_base_url",
            "http://0.0.0.0:8001"
        )

        url = base_url + "/validate_exercise"

        params = {
            'exercise_id': exercise_id,
            'session_token': session_token,
            'user_login': 'admin',
            'db': http.request.env.cr.dbname
        }

        try:
            response = requests.get(url, params=params, timeout=10)
            return {"result": response.text}
        except Exception as e:
            return {"error": str(e)}

    @http.route("/ai_chat/feedback", type="jsonrpc", auth="user")
    def ai_chat_feedback(self, message_uid, vote=None, comment=None, context=None, message_body_html=None,
                         message_body_text=None, **kw):
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
