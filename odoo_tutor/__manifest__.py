{
    "name": "Odoo Tutor",
    "version": "20.0.1.0.2",
    "category": "Extra Tools",
    "summary": "Contextual AI tutoring and guided exercises inside Odoo.",
    "author": "Erick Birbe <ebirbe@odooconcept.com>, Odoo Concept",
    "support": "ebirbe@odooconcept.com",
    "website": "https://odooconcept.com",
    "depends": [
        "sale_management",
        "stock",
        "crm",
        "sale",
        "web",
        "web_tour",
        "bus",
    ],
    "data": [
        "security/ir.access.csv",
        "views/odoo_tutor_menus.xml",
        "views/res_config_settings_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "odoo_tutor/static/lib/nlux/theme/nova.css",
            "odoo_tutor/static/lib/nlux/umd/nlux-core.js",
            "odoo_tutor/static/src/**/*",
        ],
    },
    "i18n": [
        "i18n/es.po",
    ],
    "installable": True,
    "application": True,
    "auto_install": False,
    "images": [
        "static/description/tutor_sidebar_screenshot.png",
        "static/description/tutor_settings_screenshot.png",
    ],
    "license": "OPL-1",
}
