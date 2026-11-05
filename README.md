# Odoo Tutor

Odoo Tutor add-on source for Odoo 20. The installable module is in `odoo_tutor/`.

## Optional exercise skip button

Set `ODOO_TUTOR_ENABLE_SKIP_STEP=true` in the Odoo server environment to enable
the exercise skip button. It is disabled by default. Accepted enabled values
are `1`, `true`, `yes`, and `on` (case-insensitive). Restart Odoo after changing
the setting. The floating tutor button also offers skip when the tutor reports
that the learner is stuck on an exercise step.
# WebSocket ticket provisioning

Each Odoo database receives a stable installation ID the first time the Odoo
Tutor settings are opened or a ticket is requested. For each installation,
generate a unique high-entropy secret outside the browser:

```sh
openssl rand -base64 48
```

Set `ODOO_TUTOR_WS_TICKET_SECRET` as a secret in the Odoo server environment.
Register the displayed installation ID and the same per-installation secret in
the WebSocket backend's tenant registry. Use a distinct secret for each
installation; do not reuse the backend API key. The signing secret stays
server-side and is never returned through Odoo settings or browser code.
The backend registry entry uses this shape (add it to the existing tenant
registry without replacing other installations):

```json
{
  "<installation-uuid>": {
    "secret": "<same per-installation secret>",
    "origins": ["https://odoo.example.com"],
    "enabled": true
  }
}
```

The backend reads this registry from `WEBSOCKET_TICKET_TENANTS_JSON`.

For key rotation, update the secret in both Odoo's server environment and the
backend tenant registry, then restart/redeploy both services. This invalidates
outstanding tickets immediately. To revoke an installation, disable or remove
its backend tenant registration and clear its Odoo secret. If a database is
cloned, assign the clone a new UUID in **Settings → Odoo Tutor**, create a new
secret, and register the clone separately.

The frontend now sends an `auth_ticket` first frame and waits for an
`authenticated` acknowledgement. The backend's configured tenant secret and
allowed Origins must match the Odoo installation. The backend consumes each
`jti` atomically and emits its acknowledgement before handling events.
