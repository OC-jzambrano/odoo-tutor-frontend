Odoo-Tutor
===========

Odoo-Tutor is a simple Odoo module that provides a set of tools to help you learn Odoo development. It includes a series of tutorials, exercises, and quizzes to help you understand the basics of Odoo development and best practices.
It is designed for beginners who want to learn Odoo development in a structured way. The module is easy to install and use, and it provides a fun and interactive way to learn Odoo development.

AI provider setup
-----------------

An administrator configures the backend URL, WebSocket URL and backend
authentication key in Odoo AI Tutor settings. Each Odoo user then selects
Bedrock, OpenAI, Gemini or Anthropic and enters their provider credentials in
Preferences > Odoo AI Tutor. Provider credentials are saved per Odoo user and
are sent only from the Odoo server to the backend when a short-lived chat
ticket is issued. They are not included in the addon or browser WebSocket URL.

For local Bedrock development, the backend may use its AWS profile or IAM role;
users can leave their personal AWS keys blank when that server credential is
available. Production deployments should use HTTPS for the backend and WSS for
the WebSocket endpoint.
