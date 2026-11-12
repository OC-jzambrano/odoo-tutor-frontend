import json
import os
import time
import uuid
import requests
from urllib.parse import urlsplit, urlunsplit
from odoo import http
from odoo.http import request

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL
from ..services.tutor_service_config import (
    backend_api_base_from_ws_url,
    canonical_https_origin,
    parse_ticket_response,
    parse_activation_response,
)
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

    @http.route("/ai_chat/ws_ticket", type="jsonrpc", auth="user", methods=["POST"])
    def ws_ticket(self, **kwargs):
        """Request a short-lived ticket from the backend for the logged-in Odoo user."""
        params = request.env["ir.config_parameter"].sudo()
        installation_id = params.get_str("odoo_tutor.installation_id", "")
        credential = params.get_str("odoo_tutor.installation_credential", "")
        activation_status = params.get_str("odoo_tutor.activation_status", "inactive")
        if activation_status == "revoked":
            return {"error": "Tutor service installation was revoked"}
        try:
            installation_id = str(uuid.UUID(installation_id))
            origin = canonical_https_origin(
                request.httprequest.headers.get("Origin")
                or request.httprequest.url_root
                or params.get_str("web.base.url", "")
            )
            api_base = backend_api_base_from_ws_url(self._get_ws_base_url())
        except (TypeError, ValueError, UnicodeError):
            return {"error": "Odoo public HTTPS URL is not configured"}
        if not credential:
            # The hosted trial is bounded per authenticated Odoo user by the backend.
            # Serialize first use so parallel browser sessions do not rotate credentials.
            request.env.cr.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                ("odoo_tutor_trial_installation:" + installation_id,),
            )
            credential = params.get_str("odoo_tutor.installation_credential", "")
            if not credential:
                try:
                    provisioned = requests.post(
                        api_base + "/odoo/trial-installation",
                        json={
                            "installation_id": installation_id,
                            "origin": origin,
                            "addon_version": "20.0.1.0.2",
                        },
                        timeout=(3, 10),
                        allow_redirects=False,
                    )
                    if provisioned.status_code != 200:
                        return {"error": "Tutor trial service is unavailable"}
                    credential = parse_activation_response(
                        provisioned.json(), installation_id
                    )
                    params.set_str("odoo_tutor.installation_credential", credential)
                    params.set_str("odoo_tutor.activation_status", "active")
                except (requests.RequestException, ValueError, TypeError):
                    return {"error": "Tutor trial service is unavailable"}
        if (
            not isinstance(credential, str)
            or not 32 <= len(credential) <= 4096
            or any(ord(char) < 32 for char in credential)
        ):
            return {"error": "Tutor service installation is not active"}
        try:
            ticket_payload = {
                "installation_id": installation_id,
                "user_id": request.env.user.id,
                "login": request.env.user.login,
                "database": request.env.cr.dbname,
                "origin": origin,
                "protocol_version": 1,
            }
            provider_key = params.get_str("odoo_tutor.llm_api_key", "").strip()
            if provider_key:
                provider = params.get_str("odoo_tutor.llm_provider", "openai")
                if provider not in {"openai", "anthropic", "google"}:
                    return {"error": "Configured AI provider is invalid"}
                ticket_payload["provider_config"] = {
                    "provider": provider,
                    "api_key": provider_key,
                }
            response = requests.post(
                api_base + "/odoo/ws-ticket",
                json=ticket_payload,
                headers={"Authorization": "Bearer " + credential},
                timeout=(3, 8),
                allow_redirects=False,
            )
            if response.status_code != 200:
                if response.status_code in (401, 403):
                    params.set_str("odoo_tutor.activation_status", "revoked")
                    params.set_str("odoo_tutor.installation_credential", "")
                    return {"error": "Tutor service installation was revoked; activate it again"}
                return {"error": "Tutor ticket service rejected the request"}
            try:
                ticket, expires_at = parse_ticket_response(response.json(), time.time())
            except (TypeError, ValueError):
                return {"error": "Tutor ticket service returned an invalid response"}
            return {"ticket": ticket, "expires_at": expires_at}
        except (requests.RequestException, ValueError, TypeError, UnicodeError):
            return {"error": "Tutor ticket service is unavailable"}

    @http.route("/ai_chat/session/<string:session_id>/messages", type="jsonrpc", auth="user")
    def session_messages(self, session_id, **kwargs):
        """Fetch a transcript for the authenticated Odoo user."""
        ws_url = self._get_ws_base_url()
        parsed = urlsplit(ws_url)
        host = parsed.hostname or "localhost"
        if host in {"localhost", "127.0.0.1"}:
            host = "host.docker.internal"
        scheme = "https" if parsed.scheme == "wss" else "http"
        port = parsed.port
        base_url = urlunsplit((scheme, f"{host}:{port}" if port else host, "", "", ""))
        try:
            response = requests.get(
                f"{base_url}/session/{session_id}/messages",
                params={"user_login": request.env.user.login, "db": request.env.cr.dbname},
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
