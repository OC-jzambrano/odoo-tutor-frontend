import json

from odoo import http
from odoo.http import request

from .ai.ai_bot import AiBot


class AiChatController(http.Controller):
    @http.route("/ai_chat/chat", type="json", auth="user", methods=["POST"])
    def get_quickboard_item(self, **kwargs):
        """Endpoint principal para el chatbot AI"""
        env = request.env
        bot = AiBot(env)
        response = {"error": None, "result": None}

        try:
            # Obtener datos del cuerpo de la solicitud
            if request.httprequest.data:
                data = json.loads(request.httprequest.data)
            else:
                raise ValueError("Cuerpo de la solicitud vacío")

            message = data.get("message")
            context = data.get("context", {})
            history = data.get("history", [])

            # Validación del mensaje
            if not message or not isinstance(message, str):
                raise ValueError("El parámetro 'message' es requerido y debe ser texto")

            response["result"] = bot.chat(
                message=message, context=context, streaming=False, history=history
            )

            return response["result"]

        except Exception as e:
            return f"Error: {e}"
