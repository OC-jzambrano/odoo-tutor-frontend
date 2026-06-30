# Playwright browser tests

The tests target `http://localhost:8069` by default and reuse a locally saved Odoo login.

1. Start Odoo.
2. Run `npm run test:e2e:auth` and log in through the Chromium window.
3. Run `npm run test:e2e`.

Use `npm run test:e2e:headed`, `npm run test:e2e:ui`, or `npm run test:e2e:debug` while developing tests.

Set `ODOO_BASE_URL` to test another local URL:

```powershell
$env:ODOO_BASE_URL = "http://localhost:8070"
npm run test:e2e
```

Authentication state and failure artifacts are excluded from Git. Rerun the authentication command if the saved Odoo session expires.
