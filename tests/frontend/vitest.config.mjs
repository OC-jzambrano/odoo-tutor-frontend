import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function resolveOdooExtensionlessImports() {
  return {
    name: "resolve-odoo-extensionless-imports",
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith(".") || /\.[cm]?js$/.test(source)) {
        return null;
      }

      const resolved = await this.resolve(`${source}.js`, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved || null;
    },
  };
}

export default defineConfig({
  root: repoRoot,
  plugins: [resolveOdooExtensionlessImports()],
  test: {
    environment: "node",
    include: ["tests/frontend/unit/**/*.test.mjs"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage/frontend",
      include: [
        "odoo_mentor/static/src/core/client_validation_event.js",
        "odoo_mentor/static/src/core/event_types.js",
        "odoo_mentor/static/src/core/interaction_events.js",
        "odoo_mentor/static/src/core/normalize_event.js",
        "odoo_mentor/static/src/core/orm_event.js",
        "odoo_mentor/static/src/core/outcome_state.js",
        "odoo_mentor/static/src/core/record_id.js",
        "odoo_mentor/static/src/core/state_transition.js",
      ],
    },
  },
});
