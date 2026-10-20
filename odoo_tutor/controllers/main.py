from odoo import http


class OdooTutorController(http.Controller):
    @http.route('/odoo_tutor/chat', type='jsonrpc', auth='user', methods=['POST'])
    def tutor_chat(self, **kwargs):
        """Deprecated HTTP chat route; the client uses the authenticated WebSocket flow."""
        return {
            "error": True,
            "response": "Esta ruta ya no está activa. Recarga Odoo AI Tutor para usar el chat seguro.",
        }
