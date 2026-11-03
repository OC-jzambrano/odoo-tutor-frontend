from odoo import models, fields, api, _
from odoo.tools import html2plaintext


class AiChatFeedback(models.Model):
    _name = "ai.chat.feedback"
    _description = "AI Chat Feedback"
    _order = "create_date desc"

    user_id = fields.Many2one(
        "res.users", required=True, default=lambda self: self.env.user, index=True
    )

    # Identificador que recibes del frontend
    message_uid = fields.Char(required=True, index=True)

    # (Opcional) si el mensaje existe como mail.message, lo linkeamos
    mail_message_id = fields.Many2one("mail.message", index=True, ondelete="set null")

    # SNAPSHOT del contenido del mensaje al que se le hace feedback
    message_body_html = fields.Html(string="Message (HTML)", sanitize=False)
    message_body_text = fields.Text(string="Message (Text)", index=False)

    vote = fields.Selection([("up", "Up"), ("down", "Down")], index=True)
    comment = fields.Text()

    context_model = fields.Char(index=True)
    context_res_id = fields.Integer(index=True)
    context_json = fields.Json()

    _sql_constraints = [
        ("uniq_user_msg_vote", "unique(user_id, message_uid, vote)", "Duplicate vote for the same message."),
    ]

    @api.model_create_multi
    def create(self, vals_list):
        """
        Garantiza que se guarde el contenido del mensaje aunque luego lo borren,
        y si podemos, enlazamos el mail.message.
        """
        for vals in vals_list:
            # 1) Normaliza texto/html si vino uno solo
            if vals.get("message_body_html") and not vals.get("message_body_text"):
                vals["message_body_text"] = html2plaintext(vals["message_body_html"] or "")
            elif vals.get("message_body_text") and not vals.get("message_body_html"):
                # si te llega texto plano, lo dejamos en text; html puede quedar vacío
                pass

            # 2) Si no vino contenido, intenta resolverlo desde mail.message usando message_uid
            if not vals.get("message_body_html") and not vals.get("message_body_text"):
                msg = self._resolve_mail_message(vals.get("message_uid"))
                if msg:
                    vals.setdefault("mail_message_id", msg.id)
                    vals.setdefault("message_body_html", msg.body or "")
                    vals.setdefault("message_body_text", html2plaintext(msg.body or ""))

        return super().create(vals_list)

    def _resolve_mail_message(self, message_uid):
        """
        Intenta mapear message_uid a un mail.message.
        Soporta:
        - uid numérico (id de mail.message)
        - uid tipo Message-Id (cabecera email) en mail.message.message_id
        """
        if not message_uid:
            return False

        MailMessage = self.env["mail.message"].sudo()

        # Caso 1: uid es un id numérico
        if str(message_uid).isdigit():
            msg = MailMessage.browse(int(message_uid))
            return msg if msg.exists() else False

        # Caso 2: uid coincide con message_id (cabecera) o similar
        msg = MailMessage.search([("message_id", "=", message_uid)], limit=1)
        return msg or False
