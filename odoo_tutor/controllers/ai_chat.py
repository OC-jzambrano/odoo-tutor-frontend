import json
import os
from urllib.parse import urlsplit

import requests

from odoo import http
from odoo.http import request

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL


class AiChatController(http.Controller):
    @staticmethod
    def _get_param(params, key, default=""):
        record = params.search([("key", "=", key)], limit=1)
        return (record.value if record else None) or default

    @staticmethod
    def _env_flag(name, default=False):
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    def _get_ws_base_url(self):
        params = request.env["ir.config_parameter"].sudo()
        ws_base_url = self._get_param(
            params, "odoo_tutor.chatbot_ws_base_url", DEFAULT_CHATBOT_WS_BASE_URL
        )
        return (ws_base_url or "").strip() or DEFAULT_CHATBOT_WS_BASE_URL

    @http.route("/ai_chat/ws_config", type="jsonrpc", auth="user")
    def ws_config(self, session_id=None, **kwargs):
        params = request.env["ir.config_parameter"].sudo()
        uid = request.env.user.id
        provider_config = {
            "provider": self._get_param(params, f"odoo_tutor.user.{uid}.provider", "bedrock"),
            "model": self._get_param(params, f"odoo_tutor.user.{uid}.model"),
            "region": self._get_param(params, f"odoo_tutor.user.{uid}.region", "eu-north-1"),
            "api_key": self._get_param(params, f"odoo_tutor.user.{uid}.api_key"),
            "api_secret": self._get_param(params, f"odoo_tutor.user.{uid}.api_secret"),
        }
        if provider_config["provider"] != "bedrock" and not provider_config["api_key"].strip():
            return {
                "error": True,
                "message": "Introduce la API key del proveedor seleccionado en los ajustes de Odoo AI Tutor.",
            }
        if provider_config["provider"] == "bedrock" and bool(
            provider_config["api_key"].strip()
        ) != bool(provider_config["api_secret"].strip()):
            return {
                "error": True,
                "message": "Para usar credenciales AWS personales de Bedrock, introduce tanto el access key como el secret key; o deja ambos vacíos para usar las credenciales del servidor.",
            }
        backend_url = (
            self._get_param(params, "odoo_tutor.backend_url")
            or "http://host.docker.internal:8002"
        ).strip().rstrip("/")
        backend_api_key = (self._get_param(params, "odoo_tutor.chatbot_api_key") or "").strip()
        backend_parts = urlsplit(backend_url)
        local_hosts = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}
        if backend_parts.scheme != "https" and not (
            backend_parts.scheme == "http" and backend_parts.hostname in local_hosts
        ):
            return {
                "error": True,
                "message": "El backend debe usar HTTPS para enviar credenciales de proveedor.",
            }
        ws_url = self._get_ws_base_url()
        ws_parts = urlsplit(ws_url)
        if ws_parts.scheme != "wss" and not (
            ws_parts.scheme == "ws" and ws_parts.hostname in local_hosts
        ):
            return {
                "error": True,
                "message": "El WebSocket debe usar WSS salvo en el entorno local.",
            }
        if not backend_api_key:
            return {
                "error": True,
                "message": "El administrador debe configurar la API key del backend del tutor.",
            }
        try:
            ticket_response = requests.post(
                f"{backend_url}/ws/tickets",
                json={
                    "user_login": request.env.user.login,
                    "db": request.env.cr.dbname,
                    "session_id": session_id,
                    "provider_config": provider_config,
                },
                headers={"X-API-Key": backend_api_key},
                timeout=10,
            )
            if ticket_response.status_code != 200:
                return {
                    "error": True,
                    "message": f"El backend rechazó la solicitud de conexión (HTTP {ticket_response.status_code}).",
                }
            ticket = ticket_response.json().get("ticket")
        except requests.RequestException:
            return {"error": True, "message": "No se pudo conectar con el backend del tutor."}

        if not ticket:
            return {"error": True, "message": "El backend no devolvió un ticket de conexión."}
        return {
            "ws_base_url": ws_url,
            "enable_skip_step": self._env_flag("ODOO_TUTOR_ENABLE_SKIP_STEP"),
            "ticket": ticket,
        }

    @http.route("/ai_chat/ws_ticket", type="jsonrpc", auth="user", methods=["POST"])
    def ws_ticket(self, session_id=None, **kwargs):
        """Legacy endpoint; the frontend uses ws_config with the provider agnostic contract."""
        return {
            "error": True,
            "code": "ENDPOINT_DEPRECATED",
            "message": "Recarga el cliente para negociar una conexión segura de chat.",
        }

    @http.route("/ai_chat/session_history", type="jsonrpc", auth="user", methods=["POST"])
    def get_session_history(self, session_id=None, **kwargs):
        """Retrieve persisted chat history for reconnect replay, protected by user auth and backend key."""
        if not session_id:
            return {"messages": []}

        config_params = request.env["ir.config_parameter"].sudo()
        backend_url = (self._get_param(config_params, "odoo_tutor.backend_url") or "http://localhost:8001").strip().rstrip("/")
        backend_api_key = (self._get_param(config_params, "odoo_tutor.chatbot_api_key") or "").strip()

        headers = {"X-API-Key": backend_api_key}
        params = {
            "db": str(request.env.cr.dbname),
            "uid": str(request.env.user.id),
            "user_login": request.env.user.login,
        }

        try:
            res = requests.get(
                f"{backend_url}/session/{session_id}/messages",
                headers=headers,
                params=params,
                timeout=10,
            )
            if res.status_code == 200:
                data = res.json()
                return {"messages": data.get("messages", [])}
        except Exception:
            pass

        return {"messages": []}

    @http.route("/ai_chat/chat", type="jsonrpc", auth="user", methods=["POST"])
    def get_quickboard_item(self, **kwargs):
        """Deprecated: Interactive chat must use WebSocket transport exclusively."""
        return {
            "error": True,
            "response": "Deprecated: interactive chat must use WebSocket transport.",
        }

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

        session_token = self._get_param(config_params, "odoo_tutor.chatbot_session_token", "0")

        base_url = self._get_param(
            config_params,
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
