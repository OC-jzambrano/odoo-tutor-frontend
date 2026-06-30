# Local Playwright browser testing

## Design

Playwright targets an already-running Odoo instance at `http://localhost:8069`. Chromium is the only configured browser to keep local feedback fast. The base URL can be overridden through `ODOO_BASE_URL`.

Authentication is captured interactively by a standalone command. The command opens Odoo in Chromium, waits for the authenticated web client, and writes the browser storage state to `tests/e2e/.auth/user.json`. That directory is ignored by Git because the state contains session credentials. Test runs load the saved state into isolated browser contexts.

The initial smoke test verifies that `/web` renders the authenticated Odoo web client. Failed tests retain traces, screenshots, and video; successful tests do not retain those artifacts. Playwright does not manage the Odoo process. A stopped server therefore produces a normal navigation failure with the target URL visible in the test output.
