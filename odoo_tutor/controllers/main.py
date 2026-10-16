import json
import logging
import requests
from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class OdooTutorController(http.Controller):

    @http.route('/odoo_tutor/chat', type='json', auth='user', methods=['POST'])
    def tutor_chat(self, message=None, context=None, **kwargs):
        """
        Proxy controller between OWL frontend and FastAPI AI microservice:
        - Forwards user's message and active Odoo context.
        - Injects user's OpenAI API key (BYOK) via X-OpenAI-Key header.
        - Injects backend authentication credential via X-API-Key header.
        """
        # Resolve message and context from parameters or request body
        if not message:
            message = kwargs.get('message')
        if not context:
            context = kwargs.get('context')

        if (not message or not context) and request.httprequest.data:
            try:
                raw_body = json.loads(request.httprequest.data.decode('utf-8'))
                params_body = raw_body.get('params', {})
                message = message or params_body.get('message') or raw_body.get('message')
                context = context or params_body.get('context') or raw_body.get('context')
            except Exception:
                pass

        # Validate message
        if not message or not isinstance(message, str) or not message.strip():
            return {
                "error": True,
                "response": "⚠️ El mensaje es requerido y no puede estar vacío."
            }

        # Normalize context
        if not isinstance(context, dict):
            context = {}

        if not context.get('model') or not str(context.get('model')).strip():
            fallback_model = request.params.get('model') or getattr(request, 'model', None) or 'base'
            context['model'] = str(fallback_model).strip()

        config_params = request.env['ir.config_parameter'].sudo()
        openai_key = (config_params.get_param('odoo_tutor.openai_key') or '').strip()
        backend_url = (config_params.get_param('odoo_tutor.backend_url') or 'http://localhost:8001').strip().rstrip('/')
        backend_api_key = (config_params.get_param('odoo_tutor.chatbot_api_key') or 'your-super-secret-key-123').strip()

        if not openai_key:
            return {
                "error": True,
                "response": "⚠️ Configura primero tu OpenAI API Key en Ajustes -> Odoo AI Tutor."
            }

        payload = {
            "message": message.strip(),
            "context": context,
        }

        headers = {
            "Content-Type": "application/json",
            "X-OpenAI-Key": openai_key,
            "X-API-Key": backend_api_key,
        }

        try:
            res = requests.post(
                f"{backend_url}/chat",
                json=payload,
                headers=headers,
                timeout=30
            )

            if res.status_code == 200:
                return res.json()

            # Handle structured error responses
            error_detail = res.text
            try:
                error_json = res.json()
                if "detail" in error_json:
                    error_detail = error_json["detail"]
            except Exception:
                pass

            if res.status_code == 401:
                return {
                    "error": True,
                    "response": f"Error de autenticación con el backend: {error_detail}"
                }
            elif res.status_code == 422:
                return {
                    "error": True,
                    "response": f"Error de validación en la solicitud: {error_detail}"
                }

            return {
                "error": True,
                "response": f"Error del servidor ({res.status_code}): {error_detail}"
            }
        except requests.RequestException as e:
            _logger.exception("Error connecting to Odoo Tutor backend: %s", e)
            return {
                "error": True,
                "response": f"No se pudo conectar con el servidor de Odoo Tutor: {str(e)}"
            }
