"""Keep incompatible migrated modules out of Odoo.sh upgrade operations."""

BLOCKED_MODULES = (
    "onecal_integration",
    "odoo_connector",
    "oc-snippets",
    "oc_customization",
    "oc_snippets",
)

BLOCKING_STATES = (
    "to install",
    "to upgrade",
    "to remove",
    "installed",
)


def migrate(cr, version):
    cr.execute(
        """
        UPDATE ir_module_module
           SET state = 'uninstalled'
         WHERE name IN %s
           AND state IN %s
        """,
        (BLOCKED_MODULES, BLOCKING_STATES),
    )
