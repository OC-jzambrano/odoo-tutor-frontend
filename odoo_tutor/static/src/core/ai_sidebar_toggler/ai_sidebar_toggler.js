/* eslint-disable */
/** @odoo-module **/
import {Component, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";

export class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");
        this.state = useState({showButton: false});
        this.modules = [
            "sale.order",
            "sale,report",
            "res.partner",
            "stock.picking",
            "stock.picking.type",
            "stock.location",
            "stock.quant",
            "stock.move",
            "stock.lot",
            "stock.warehouse",
            "stock.rule",
            "stock.scrap",
            "stock.warehouse.orderpoint",
            "product.template",
            "product.product",
            "product.category",
            "product.supplierinfo",
            "product.pricelist",
            "product.pricelist.item",
            "product.attribute",
            "product.attribute.value",
            "product.template.attribute.value",
            "product.supplierinfo",
            "product.supplierinfo.product",
            "product.supplierinfo.product.category",
            "product.supplierinfo.product.product",
            "purchase.order",
            "account.journal",
            "account.account",
            "account.payment",
            "account.move",
            "account.invoice",
            "purchase.order",
        ];

        this._interval = setInterval(() => {
            let detectedModel = null;
            let model = null;
            let showButton = false;
            const currentAction = this.actionService.currentController?.props;

            if (currentAction) {
                const currentModel = currentAction.resModel;
                console.log("currentModel", currentModel);

                if (this.modules.includes(currentModel)) {
                    showButton = true;
                }
            }

            this.state.showButton = showButton;

            // Variables utiles para saber si esta creando una orden de venta, pero
            // se debe mejorar para que funcione con cualquier modelo
            const currentPath2 = window.location.pathname;
            const isCreatingSaleOrder = currentPath2 === "/odoo/sales/new";
            const currentPath = window.location.href;

            console.log("currentPath2", currentPath2);
            console.log("isCreatingSaleOrder", isCreatingSaleOrder);
            console.log("currentPath", currentPath);
            console.log("detectedModel", detectedModel);

            if (isCreatingSaleOrder) {
                this.contextService.setContext("sale.order", "form", "create");
            } else if (detectedModel) {
                this.contextService.setContext(detectedModel, "form", "create");
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
