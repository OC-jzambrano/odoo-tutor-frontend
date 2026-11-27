{
    "name": "Odoo Tutor",
    "version": "20.0.1.0.2",
    "category": "Extra Tools",
    "summary": "Learn Odoo 20 with contextual AI guidance, hands-on exercises, and custom exercise recording for your company.",
    "description": """
Odoo Tutor — Contextual AI Learning Companion for Odoo 20
=========================================================

Learn Odoo 20 while you work with step-by-step interactive guidance, visual UI
spotlights, and contextual hints directly inside your Odoo workspace.

Try it out by sending the chatbot a message like this:
-------------------------------
- How to configure task dependencies in Odoo Project?
- How to create a sales quotation from scratch for a new B2B customer?
- How to configure purchase warnings on products?
- How to create a replenishment rule?
- How to configure and manage activities in Odoo CRM?

Watch the full 1080p HD demo video: https://youtu.be/Ki0tSjDGM0k
""",
    "author": "Juan Zambrano <juanzamdev@gmail.com>, Odoo Concept",
    "support": "juanzamdev@gmail.com",
    "website": "https://odooconcept.com",
    "live_test_url": "https://demo.iapps.bond/demo/start",
    "depends": ["base", "web"],
    "data": [
        "security/odoo_tutor_security.xml",
        "security/ir.access.csv",
        "views/odoo_tutor_menus.xml",
        "views/res_config_settings_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "odoo_mentor/static/lib/nlux/theme/nova.css",
            "odoo_mentor/static/lib/nlux/umd/nlux-core.js",
            "odoo_mentor/static/src/**/*",
        ],
    },
    "i18n": [
        "i18n/es.po",
    ],
    "images": [
        "static/description/banner.png",
        "static/description/demo_sales_quotation.gif",
        "static/description/tutor_crm_exercise.png",
        "static/description/tutor_welcome_preview.png",
    ],
    "installable": True,
    "application": True,
    "auto_install": False,
    "license": "OPL-1",
    "price": 0.0,
    "currency": "EUR",
}
