{
    "name": "Odoo Tutor",
    "version": "20.0.1.0.2",
    "category": "Extra Tools",
    "summary": "Learn Odoo 20 with contextual AI guidance and hands-on exercises.",
    "author": "Juan Zambrano <juanzamdev@gmail.com>, Odoo Concept",
    "support": "juanzamdev@gmail.com",
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
    ],
    "installable": True,
    "application": True,
    "auto_install": False,
    "license": "OPL-1",
    "price": 9.0,
    "currency": "EUR",
}
