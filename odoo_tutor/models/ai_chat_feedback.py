from odoo import models, fields, api, _
from odoo.tools import html2plaintext


class AiChatFeedback(models.Model):
    _name = "ai.chat.feedback"
    _description = "AI Chat Feedback"
    _order = "create_date desc"

    user_id = fields.Many2one(
        "res.users", required=True, default=lambda self: self.env.user, index=True
    )

    # Identifier received from the frontend.
    message_uid = fields.Char(required=True, index=True)

    # Link the message when it exists as a mail.message record.
    mail_message_id = fields.Many2one("mail.message", index=True, ondelete="set null")

    # Snapshot of the message content being rated.
    message_body_html = fields.Html(string="Message (HTML)", sanitize=False)
    message_body_text = fields.Text(string="Message (Text)", index=False)

    vote = fields.Selection([("up", "Up"), ("down", "Down")], index=True)
    comment = fields.Text()

    context_model = fields.Char(index=True)
    context_res_id = fields.Integer(index=True)
    context_json = fields.Json()

    _uniq_user_msg_vote = models.Constraint(
        "UNIQUE(user_id, message_uid, vote)",
        "Duplicate vote for the same message.",
    )

    @api.model_create_multi
    def create(self, vals_list):
        """
        Preserve the message content and link its mail.message record when possible.
        """
        for vals in vals_list:
            # Normalize the text and HTML bodies when only one is provided.
            if vals.get("message_body_html") and not vals.get("message_body_text"):
                vals["message_body_text"] = html2plaintext(vals["message_body_html"] or "")
            elif vals.get("message_body_text") and not vals.get("message_body_html"):
                # Keep the plain-text body when HTML is not provided.
                pass

            # Resolve the source mail.message when neither body is provided.
            if not vals.get("message_body_html") and not vals.get("message_body_text"):
                msg = self._resolve_mail_message(vals.get("message_uid"))
                if msg:
                    vals.setdefault("mail_message_id", msg.id)
                    vals.setdefault("message_body_html", msg.body or "")
                    vals.setdefault("message_body_text", html2plaintext(msg.body or ""))

        return super().create(vals_list)

    def _resolve_mail_message(self, message_uid):
        """
        Resolve a message_uid to a mail.message record.

        Supports a numeric mail.message ID or an email Message-ID header.
        """
        if not message_uid:
            return False

        MailMessage = self.env["mail.message"].sudo()

        # Resolve a numeric mail.message ID.
        if str(message_uid).isdigit():
            msg = MailMessage.browse(int(message_uid))
            return msg if msg.exists() else False

        # Resolve a matching Message-ID header.
        msg = MailMessage.search([("message_id", "=", message_uid)], limit=1)
        return msg or False
