import json
import logging
from odoo.http import request

_logger = logging.getLogger(__name__)

try:
    from websocket import create_connection
except Exception:
    create_connection = None


class AiBot:
    def __init__(self, env, ws_session_id=None):
        self.env = env
        self.ws_session_id = ws_session_id
        self.ws_base_url = "wss://tutor-backend.odooconcept.com/ws"
        self.api_key = self.env["ir.config_parameter"].sudo().get_param(
            "odoo_tutor.chatbot_api_key", "your_super_secret_key_123"
        )

    def _ws_url(self, *, user_login: str, db: str, session_id: str | None):
        # mismos params que JS
        parts = [f"user_login={user_login}", f"db={db}"]
        if session_id:
            parts.append(f"session_id={session_id}")
        return self.ws_base_url + "?" + "&".join(parts)

    def _chat(self, message: str, context: dict):
        if not create_connection:
            return {"response": "Missing dependency: websocket-client"}

        user_login = request.env.user.login
        db = request.env.cr.dbname
        # en Odoo suele ser request.session.sid; si en tu JS usas odoo.session_info.session_id, suelen coincidir.
        session_id = self.ws_session_id

        url = self._ws_url(user_login=user_login, db=db, session_id=session_id)

        headers = [
            f"X-API-KEY: {self.api_key}",
        ]

        ws = None
        try:
            ws = create_connection(url, header=headers, timeout=20)

            payload = {
                "type": "chat",
                "message": message,
                "context": context or {},
            }
            ws.send(json.dumps(payload))

            raw = ws.recv()  # si tu backend manda JSON final
            data = json.loads(raw) if raw else {}

            return {
                "response": data.get("response"),
                "exercise_id": data.get("exercise_id"),
            }
        except Exception as e:
            _logger.exception("WS chat failed: %s", e)
            return {"response": "WS communication error", "error": str(e)}
        finally:
            try:
                if ws:
                    ws.close()
            except Exception:
                pass
