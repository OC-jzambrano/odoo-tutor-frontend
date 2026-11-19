import json
import os
import time
import uuid
import requests
from urllib.parse import urlsplit, urlunsplit
from odoo import http
from odoo.http import request

from ..constants import DEFAULT_CHATBOT_WS_BASE_URL, default_chatbot_ws_base_url
from ..services.tutor_service_config import (
    backend_api_base_from_ws_url,
    canonical_https_origin,
    parse_ticket_response,
    parse_activation_response,
)
from .ai.ai_bot import AiBot


def _server_api_base_for_request(api_base):
    """Rewrite localhost API targets to host.docker.internal when running in Docker."""
    if not os.path.exists("/.dockerenv"):
        return api_base
    parsed = urlsplit(api_base)
    host = parsed.hostname
    if host in {"localhost", "127.0.0.1"}:
        netloc = f"host.docker.internal:{parsed.port}" if parsed.port else "host.docker.internal"
        return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
    return api_base


class AiChatController(http.Controller):
    @staticmethod
    def _env_flag(name, default=False):
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    def _get_ws_base_url(self):
        default_ws_url = default_chatbot_ws_base_url()
        ws_base_url = (
            request.env["ir.config_parameter"]
            .sudo()
            .get_str("odoo_tutor.chatbot_ws_base_url", default_ws_url)
        )
        return (ws_base_url or "").strip() or default_ws_url

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
            api_base = _server_api_base_for_request(
                backend_api_base_from_ws_url(self._get_ws_base_url())
            )
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

    def _recording_proxy_context(self, required_group):
        if not request.env.user.has_group(required_group):
            return {"error": "You do not have permission for this recording action", "status": 403}, None
        params = request.env["ir.config_parameter"].sudo()
        activation_status = params.get_str("odoo_tutor.activation_status", "inactive")
        if activation_status == "revoked":
            return {"error": "Tutor service installation was revoked", "status": 403}, None
        raw_installation_id = params.get_str("odoo_tutor.installation_id", "")
        credential = params.get_str("odoo_tutor.installation_credential", "")
        try:
            installation_id = str(uuid.UUID(raw_installation_id))
            api_base = _server_api_base_for_request(
                backend_api_base_from_ws_url(self._get_ws_base_url())
            )
        except (TypeError, ValueError, UnicodeError):
            return {"error": "Tutor installation is not configured", "status": 503}, None
        if (
            not isinstance(credential, str)
            or not 32 <= len(credential) <= 4096
            or any(ord(char) < 32 for char in credential)
        ):
            return {"error": "Tutor service installation is not active", "status": 401}, None
        headers = {
            "Authorization": "Bearer " + credential,
            "X-Odoo-Database": request.env.cr.dbname,
            "X-Odoo-User-Id": str(request.env.user.id),
        }
        base_path = f"{api_base}/odoo/installations/{installation_id}/recording-drafts"
        return None, (base_path, headers)

    @staticmethod
    def _proxy_backend_response(response):
        try:
            body = response.json() if response.content else {}
        except ValueError:
            body = {}
        if response.status_code >= 400:
            detail = body.get("detail") if isinstance(body, dict) else None
            return {
                "error": detail or f"Recording service returned status {response.status_code}",
                "status": response.status_code,
            }
        return {"ok": True, "data": body}

    @http.route("/ai_chat/recording_drafts/save", type="jsonrpc", auth="user", methods=["POST"])
    def save_recording_draft_proxy(self, draft=None, **kwargs):
        err, ctx = self._recording_proxy_context("odoo_mentor.group_odoo_tutor_expert")
        if err:
            return err
        if not isinstance(draft, dict):
            return {"error": "Recording draft payload is required", "status": 422}
        base_path, headers = ctx
        try:
            response = requests.put(
                base_path,
                json=draft,
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
            )
            return self._proxy_backend_response(response)
        except requests.RequestException:
            return {"error": "Recording service is unavailable", "status": 503}

    @http.route("/ai_chat/recording_drafts/list", type="jsonrpc", auth="user", methods=["POST"])
    def list_recording_drafts_proxy(self, offset=0, **kwargs):
        err, ctx = self._recording_proxy_context("odoo_mentor.group_odoo_tutor_expert")
        if err:
            return err
        base_path, headers = ctx
        try:
            safe_offset = max(0, int(offset or 0))
            response = requests.get(
                base_path,
                params={"offset": safe_offset},
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
            )
            return self._proxy_backend_response(response)
        except (requests.RequestException, TypeError, ValueError):
            return {"error": "Recording service is unavailable", "status": 503}

    @http.route("/ai_chat/recording_drafts/review_list", type="jsonrpc", auth="user", methods=["POST"])
    def list_review_drafts_proxy(self, review_status=None, offset=0, **kwargs):
        err, ctx = self._recording_proxy_context("odoo_mentor.group_odoo_tutor_reviewer")
        if err:
            return err
        base_path, headers = ctx
        params = {"offset": max(0, int(offset or 0))}
        if review_status in {"pending_review", "approved", "rejected"}:
            params["review_status"] = review_status
        try:
            response = requests.get(
                f"{base_path}/review",
                params=params,
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
            )
            return self._proxy_backend_response(response)
        except requests.RequestException:
            return {"error": "Recording service is unavailable", "status": 503}

    @http.route("/ai_chat/recording_drafts/review_detail", type="jsonrpc", auth="user", methods=["POST"])
    def review_draft_detail_proxy(self, recording_id=None, author_id=None, **kwargs):
        err, ctx = self._recording_proxy_context("odoo_mentor.group_odoo_tutor_reviewer")
        if err:
            return err
        try:
            safe_id = str(uuid.UUID(str(recording_id)))
        except (TypeError, ValueError):
            return {"error": "Invalid recording ID", "status": 422}
        base_path, headers = ctx
        params = {"author_id": str(author_id)} if author_id else {}
        try:
            response = requests.get(
                f"{base_path}/review/{safe_id}",
                params=params,
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
            )
            return self._proxy_backend_response(response)
        except requests.RequestException:
            return {"error": "Recording service is unavailable", "status": 503}

    @http.route("/ai_chat/recording_drafts/review_decision", type="jsonrpc", auth="user", methods=["POST"])
    def review_draft_decision_proxy(
        self, recording_id=None, decision=None, comment=None, author_id=None, **kwargs
    ):
        err, ctx = self._recording_proxy_context("odoo_mentor.group_odoo_tutor_reviewer")
        if err:
            return err
        try:
            safe_id = str(uuid.UUID(str(recording_id)))
        except (TypeError, ValueError):
            return {"error": "Invalid recording ID", "status": 422}
        if decision not in {"approved", "rejected"}:
            return {"error": "Invalid review decision", "status": 422}
        payload = {"decision": decision}
        if isinstance(comment, str) and comment.strip():
            payload["comment"] = comment.strip()[:240]
        if author_id is not None and str(author_id).strip():
            payload["author_id"] = str(author_id).strip()[:240]
        base_path, headers = ctx
        try:
            response = requests.post(
                f"{base_path}/review/{safe_id}",
                json=payload,
                headers=headers,
                timeout=(3, 10),
                allow_redirects=False,
            )
            return self._proxy_backend_response(response)
        except requests.RequestException:
            return {"error": "Recording service is unavailable", "status": 503}
