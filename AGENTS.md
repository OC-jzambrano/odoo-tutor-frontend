# Workspace instructions

- After any CSS, XML, or UI change in `odoo_mentor/static/src/`, run `npm run test:visual` and inspect the generated screenshots in `test-results/visual/` before reporting done.
- After any other changes to  render and visually inspect the listing page locally instead.
- After making changes in this repository, rebuild and start the local Odoo container with `docker compose -f docker-compose.documents.yml up -d --build` before reporting done.
