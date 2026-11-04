# Odoo Tutor

Odoo Tutor add-on source for Odoo 20. The installable module is in `odoo_tutor/`.

## Optional exercise skip button

Set `ODOO_TUTOR_ENABLE_SKIP_STEP=true` in the Odoo server environment to enable
the exercise skip button. It is disabled by default. Accepted enabled values
are `1`, `true`, `yes`, and `on` (case-insensitive). Restart Odoo after changing
the setting. The floating tutor button also offers skip when the tutor reports
that the learner is stuck on an exercise step.
