# Workspace instructions

- Keep all code changes strictly within the frontend scope of this repository (`odoo-tutor-frontend`). Do not modify the backend repository or backend database from here.
- Whenever a completed task or feature requires both frontend and backend work, always end your final response with a detailed **Backend Work Required** section specifying the exact endpoints, payload/response schemas, permissions, and database/index changes needed in the backend repository for the feature to work end-to-end.
- After any CSS, XML, or UI change in `odoo_mentor/static/src/`, run `npm run test:visual` and inspect the generated screenshots in `test-results/visual/` before reporting done.
- After any other changes to  render and visually inspect the listing page locally instead.
- After making changes in this repository, rebuild and start the local Odoo container with `docker compose -f docker-compose.documents.yml up -d --build` before reporting done.
