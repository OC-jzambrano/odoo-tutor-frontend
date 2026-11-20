from odoo import models, fields, api, _
from odoo.tools import html2plaintext


class AiChatFeedback(models.Model):
    _name = "ai.chat.feedback"
    _description = "AI Chat Feedback"
    _order = "create_date desc"

    user_id = fields.Many2one(
        "res.users", required=True, default=lambda self: self.env.user, index=True
    )

    # Message identifier received from the frontend.
    message_uid = fields.Char(required=True, index=True)

    # Optional mail.message ID stored without coupling depends to mail.
    mail_message_id = fields.Integer(index=True)

    # Snapshot of the message content being rated.
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
        """Store a message snapshot and link mail.message when available."""
        for vals in vals_list:
            # Populate plain text when only HTML is provided.
            if vals.get("message_body_html") and not vals.get("message_body_text"):
                vals["message_body_text"] = html2plaintext(vals["message_body_html"] or "")
            elif vals.get("message_body_text") and not vals.get("message_body_html"):
                # Keep plain text only when HTML is omitted.
                pass

            # Resolve missing content from mail.message using message_uid.
            if not vals.get("message_body_html") and not vals.get("message_body_text"):
                msg = self._resolve_mail_message(vals.get("message_uid"))
                if msg:
                    vals.setdefault("mail_message_id", msg.id)
                    vals.setdefault("message_body_html", msg.body or "")
                    vals.setdefault("message_body_text", html2plaintext(msg.body or ""))

        return super().create(vals_list)

    def _resolve_mail_message(self, message_uid):
        """Resolve message_uid to a mail.message by numeric ID or Message-Id."""
        if not message_uid or "mail.message" not in self.env:
            return False

        MailMessage = self.env["mail.message"].sudo()

        # Match numeric mail.message ID.
        if str(message_uid).isdigit():
            msg = MailMessage.browse(int(message_uid))
            return msg if msg.exists() else False

        # Match email Message-Id header.
        msg = MailMessage.search([("message_id", "=", message_uid)], limit=1)
        return msg or False
