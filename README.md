# Odoo Tutor

Odoo Tutor add-on source for Odoo 20. The installable module is in `odoo_tutor/`.

## Optional exercise skip button

Set `ODOO_TUTOR_ENABLE_SKIP_STEP=true` in the Odoo server environment to enable
the exercise skip button. It is disabled by default.

## WebSocket service and tickets

Configure a public `wss://` WebSocket URL and set Odoo's canonical public URL
to `https://...` in General Settings. For deployments behind a reverse proxy,
enable Odoo `proxy_mode` and forward the original HTTPS host and scheme so
`web.base.url` represents the browser-visible origin.

The addon does not ask customers to enter a shared service API key. Odoo
persists a UUID installation identity and obtains an installation-only
credential through the backend's hosted trial registration flow on the first
ticket request. The credential is stored in server configuration and used only
by Odoo server code for `/odoo/ws-ticket` requests; it is never returned to the browser. Revocation is enforced
by the backend when ticket requests are made.

The frontend requests a fresh ticket from Odoo for every WebSocket connection,
sends it as the first frame, and waits for the backend authentication
acknowledgement before flushing queued messages. No legacy handshake is used.

### Backend HTTP contract

The current addon contract uses `POST https://<backend>/odoo/trial-installation`
with `{installation_id, origin, addon_version}`. A successful response is
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

## Odoo Apps listing and demonstration

The customer-facing listing in `odoo_tutor/static/description/index.html`
presents Odoo Tutor for Odoo 20, with local HTTPS setup, service requirements,
and exact exercise requests from the connected catalog. Historical catalog
names or version labels may refer to Odoo 19; those exercises are compatible
with Odoo 20. The add-on, listing, supported version and all customer-facing
branding remain Odoo 20.

Featured exercise identifiers:

- `create-opportunity-manual`
- `create-b2b-sales-quotation`
- `create-storable-product`
- `activities-management`
- `define-pipeline-stages`
- `create-internal-transfer`

The listing documents a CRM exercise completed in a live Odoo 20 demo. The old
screenshots showed a retired shared-key setting and must not be used in the
customer listing. Capture fresh screenshots and an exercise GIF from the
current Odoo 20 interface before publishing visual assets; use a demo database,
sample records, and no credentials or personal information.
