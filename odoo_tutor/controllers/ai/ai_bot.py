import logging

import requests

from odoo.api import Environment

_logger = logging.getLogger(__name__)


class AiBot:
    def __init__(self, env: Environment):
        self.env = env
        # Obtener configuración de parámetros del sistema
        self.base_url = (
            self.env["ir.config_parameter"]
            .sudo()
            .get_param("odoo_tutor.chatbot_base_url", "http://0.0.0.0:8001/chat")
        )
        self.headers = {
            "Content-Type": "application/json",
            "X-API-KEY": self.env["ir.config_parameter"]
            .sudo()
            .get_param("odoo_tutor.chatbot_api_key", "your_super_secret_key_123"),
        }
        self.chat_history = []

    def _send_request(self, payload: dict, stream: bool = False):
        """Envía la solicitud al backend personalizado"""
        try:
            response = requests.post(
                self.base_url,
                headers=self.headers,
                json=payload,
                stream=stream,
                timeout=(3.05, 27),
            )
            response.raise_for_status()
            return response
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"Error comunicándose con el backend: {str(e)}") from e

    def _chat(self, message: str, context: dict) -> str:
        """Maneja el chat en modo normal"""
        try:
            payload = {"message": message, "context": context}

            response = self._send_request(payload)
            response_data = response.json()

            return response_data.get(
                "response", "Error: Respuesta inválida del backend"
            )

        except Exception as e:
            _logger.error("Error en chat: %s", str(e), exc_info=True)
            return f"Error: {str(e)}"

    def _send_stream(self, content: dict) -> bool:
        """Envía mensajes a través del bus de Odoo"""
        try:
            self.env["bus.bus"]._sendone(
                self.env.user.partner_id, "ai_bot_stream", content
            )
            return True
        except Exception as e:
            _logger.error("Error enviando stream: %s", str(e), exc_info=True)
            return False

    def chat(
        self,
        message: str,
        context: dict | None = None,
        streaming: bool = False,
        history: list[dict] = None,
    ) -> str:
        """Interfaz principal para el chat"""
        try:
            context = context or {}
            return self._chat(message, context)

        except Exception as e:
            _logger.error("Error en chat: %s", str(e), exc_info=True)
            return f"Error: {str(e)}"
