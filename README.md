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
presents Odoo Tutor for Odoo 20, including guided exercises, suggested requests,
local HTTPS setup and service requirements. Exercise identifiers and goals come
from a read-only query of the connected service catalog. The product owner has
confirmed that these exercises are compatible with Odoo 20; historical catalog
version labels are not used as customer-facing branding.

Featured exercise identifiers:
- `create-opportunity-manual`
- `create-b2b-sales-quotation`
- `create-storable-product`
- `activities-management`
- `define-pipeline-stages`
- `create-internal-transfer`

The old screenshots showed the retired shared-key setting, so they are not
included in the customer-facing listing. The listing description instead
documents the CRM exercise verified in a live Odoo 20 demo. Add a fresh capture
of the current interface before publishing screenshots; do not reuse the old
settings image.

No exercise GIF is included yet. For a final GIF, use an Odoo 20 demo database
through its HTTPS address, request `create-opportunity-manual`, confirm it,
follow one step, show a hint and capture the tutor's actual progress response.
Use sample data and exclude credentials and personal information. Keep a static
image fallback. A recorded execution is required for a live-demo claim;
owner-confirmed compatibility is not a claim that a recording has already
been made.
