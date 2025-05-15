/** @odoo-module **/
import {Component, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";

export class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.contextService = useService("context_service");
        this.state = useState({showButton: false});
        this.modules = {
            "sale.order": ["/sale/", "/sale"],
            "stock.picking": ["/inventory/", "/inventory"],
        };

        this._interval = setInterval(() => {
            const currentPath = window.location.href;
            let detectedModel = null;

            // Verificar todos los módulos en un solo loop
            for (const [model, routes] of Object.entries(this.modules)) {
                if (routes.some((route) => currentPath.includes(route))) {
                    detectedModel = model;
                    break;
                }
            }

            // Actualizar estado y mostrar en consola
            if (detectedModel) {
                this.contextService.setContext(detectedModel);
                // Console.log(detectedModel);
                this.state.showButton = true;
            } else {
                this.state.showButton = false;
            }
        }, 500);
    }

    willUnmount() {
        clearInterval(this._interval);
    }
}

registry.category("main_components").add(
    "AiFloatingButton",
    {
        Component: AiFloatingButton,
    },
    {sequence: 100}
);
