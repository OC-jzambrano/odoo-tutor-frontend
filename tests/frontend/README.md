# Frontend tests

This folder mirrors the backend test split, but for browser-side behavior.

- `unit/`: fast tests for pure frontend contracts such as event names and payload normalization.
- `browser/`: reserved for Odoo/browser flows that need a real Odoo web client.

Install the frontend test runner once:

```powershell
npm install
```

Run the current unit tests from the repository root:

```powershell
npm run test:frontend
```

Run with coverage:

```powershell
npm run test:frontend:coverage
```

The first suite protects the event-name contract between the Odoo frontend and
the backend validator. It intentionally runs without Odoo so regressions like
`button_click` vs `button_clicked` are caught quickly.
