{
    "name": "Odoo AI Tutor - Interactive Learning Sidebar",
    "version": "18.0.1.0.0",
    "category": "Productivity/AI",
    "summary": "Interactive AI-powered tutor with practical exercises and real-time hints for Odoo",
    "author": "Juan Diego Zambrano, Odoo Concept",
    "website": "https://github.com/OC-jzambrano/odoo-tutor-frontend",
    "license": "LGPL-3",
    "price": 0.0,
    "currency": "EUR",
    "depends": [
        "base",
        "web",
    ],
    "data": [
        "security/ir.model.access.csv",
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
    "images": [
        "static/description/banner.png",
    ],
    "installable": True,
    "application": True,
    "auto_install": False,
}
