/* eslint-disable */
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
            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";
            const currentPath = window.location.href;
            let detectedModel = null;

            for (const [model, routes] of Object.entries(this.modules)) {
                if (routes.some((route) => currentPath.includes(route))) {
                    detectedModel = model;
                    break;
                }
            }

            if (isCreatingSaleOrder) {
                this.contextService.setContext("sale.order", "form", "create");

                this.state.showButton = true;
            } else if (detectedModel) {
                this.contextService.setContext(detectedModel, "form", "create");
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
