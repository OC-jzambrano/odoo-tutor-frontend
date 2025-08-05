import json
import requests
from odoo import http
from odoo.http import request

from .ai.ai_bot import AiBot


class AiChatController(http.Controller):
    @http.route("/ai_chat/chat", type="json", auth="user", methods=["POST"])
    def get_quickboard_item(self, **kwargs):
        """Endpoint principal para el chatbot AI"""
        bot = AiBot(request.env)

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

            return bot.chat(
                message=message, context=context, streaming=False, history=history
            )

        except Exception as e:
            return f"Error: {e}"

    @http.route('/ai_chat/validate_exercise', type='json', auth='user')
    def validate_exercise(self, **kwargs):
        data = json.loads(http.request.httprequest.data)
        exercise_id = data.get('exercise_id')

        if not exercise_id:
            return {"error": "Missing exercise_id"}

        config_params = request.env['ir.config_parameter'].sudo()

        session_token = config_params.get_param(
            "odoo_tutor.chatbot_session_token",
            "0"
        )

        base_url = config_params.get_param(
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
