{
    "name": "Odoo Tutor",
    "version": "18.0.1.0.0",
    "category": "Extra Tools",
    "summary": "Módulo integrador para Odoo Tutor",
    "author": "Erick Birbe <ebirbe@odooconcept.com>, Odoo Concept",
    "website": "https://odooconcept.com",
    "depends": [
        "account_accountant",
        "sale_management",
        "stock",
        "crm",
        "sale",
        "web",
        "web_tour",
        "bus",
    ],
    "data": [
        "views/res_config_settings_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "odoo_tutor/static/lib/nlux/theme/nova.css",
            "odoo_tutor/static/lib/nlux/umd/nlux-core.js",
            "odoo_tutor/static/src/**/*",
        ],
    },
    "installable": True,
    "application": True,
    "auto_install": False,
    "license": "OPL-1",
}
