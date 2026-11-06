# Odoo Tutor

Odoo Tutor add-on source for Odoo 20. The installable module is in `odoo_tutor/`.

## Optional exercise skip button

Set `ODOO_TUTOR_ENABLE_SKIP_STEP=true` in the Odoo server environment to enable
the exercise skip button. It is disabled by default.

## WebSocket activation and tickets

Configure a public `wss://` WebSocket URL and set Odoo's canonical public URL
to `https://...` in General Settings. For deployments behind a reverse proxy,
enable Odoo `proxy_mode` and forward the original HTTPS host and scheme so
`web.base.url` represents the browser-visible origin.

Activation requires an activation code or license supplied by the tutor
service. The addon does not contain a master secret. In Settings → Odoo Tutor,
enter that code and activate. Odoo persists a UUID installation identity and
the installation-only credential returned by the service in server
configuration. Credentials are not returned to the browser. Revocation is
enforced by the backend when ticket requests are made.

The frontend requests a fresh ticket from Odoo for every WebSocket connection,
sends it as the first frame, and waits for the backend authentication
acknowledgement before flushing queued messages. No legacy handshake is used.

### Backend HTTP contract

The current addon contract uses `POST https://<backend>/odoo/activate` with
`{installation_id, origin, addon_version}` and an Authorization bearer
activation code. A successful response is
`{installation_id, installation_credential}`. Ticket requests go to
`POST /odoo/ws-ticket` with installation ID, authenticated Odoo user ID/login,
database, canonical origin, and protocol version; the installation credential
is sent as a bearer token. The backend returns `{ticket, expires_at}`. The
backend must validate the credential and origin, and issue brief, single-use
tickets with WebSocket audience and claims bound to installation, user,
database, origin, `iat`, `exp`, and `jti`.

This HTTP contract must be implemented by the backend before deployment. No
backend repository was changed as part of this addon task.

### AI provider selection

OpenAI is selected by default and uses the backend's configured AWS key when
the administrator leaves the provider key empty. If a key is entered, Odoo
sends `provider_config` (`provider` and `api_key`) only in its server-side
ticket request. Supported providers are OpenAI, Anthropic, and Google Gemini.
