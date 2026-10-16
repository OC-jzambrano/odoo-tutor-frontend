import logging
import requests
from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class OdooTutorController(http.Controller):

    @http.route('/odoo_tutor/chat', type='json', auth='user', methods=['POST'])
    def tutor_chat(self, message=None, **kwargs):
        if not message:
            message = kwargs.get('message')

        params = request.env['ir.config_parameter'].sudo()
        api_key = params.get_param('odoo_tutor.openai_key')
        backend_url = (params.get_param('odoo_tutor.backend_url') or 'http://localhost:8001').rstrip('/')

        if not api_key:
            return {
                "error": True,
                "response": "⚠️ Configura primero tu OpenAI API Key en Ajustes -> Odoo AI Tutor."
            }

        try:
            res = requests.post(
                f"{backend_url}/chat",
                json={"message": message},
                headers={
                    "Content-Type": "application/json",
                    "X-OpenAI-Key": api_key,
                },
                timeout=30
            )
            if res.status_code == 200:
                return res.json()
            return {
                "error": True,
                "response": f"Error del servidor ({res.status_code}): {res.text}"
            }
        except requests.RequestException as e:
            _logger.exception("Error connecting to Odoo Tutor backend: %s", e)
            return {
                "error": True,
                "response": f"No se pudo conectar con el servidor de Odoo Tutor: {str(e)}"
            }
