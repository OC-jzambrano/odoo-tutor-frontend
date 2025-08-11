/* eslint-disable */
/** @odoo-module **/
import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";

export class AiFloatingButton extends Component {
    static template = "ai_chat.AiFloatingButton";

    setup() {
        this.actionService = useService("action");
        this.contextService = useService("context_service");
        this.state = useState({
                        showButton: false,
                        logs: [],
                     });

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

        // intervalo para mostrar datos
        this.intervalId = null;

        if (this.router?.bus) {
            this.router.bus.addEventListener("ROUTE_CHANGE", (ev) => {
                console.log("Ruta cambiada", ev.detail.to);
            });
        }

        if (this.actionService?.bus) {
            this.actionService.bus.addEventListener("ACTION_EXECUTED", (ev) => {
                console.log("Acción ejecutada", ev.detail.action);
            });
        }
        // Detectar clicks en cualquier parte de la interfaz
        document.addEventListener("click", (ev) => {
            if (ev.target && ev.target.tagName) {
                this.addLog("click", {
                    tag: ev.target.tagName,
                    text: ev.target.innerText?.trim()?.slice(0, 50) || "",
                    className: ev.target.className
                });
            }
        }, true);

        // Detectar cambios en inputs y textareas
        document.addEventListener("input", (ev) => {
            if (["INPUT", "TEXTAREA"].includes(ev.target.tagName)) {
                this.addLog("input", {
                    name: ev.target.name,
                    value: ev.target.value?.slice(0, 50) || ""
                });
            }
        }, true);

        // Iniciar intervalo para mostrar logs cada 10s
        onMounted(() => {
            this.intervalId = setInterval(() => {
                if (this.state.logs.length) {
                    console.log("User activity logs:", this.state.logs);
                }
            }, 10000);
        });

        this._interval = setInterval(() => {
            let currentModel = null;
            let model = null;
            let showButton = false;
            const currentAction = this.actionService.currentController?.props;

            if (currentAction) {
                currentModel = currentAction.resModel;

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

            /*console.log("currentPath2", currentPath2);
            console.log("isCreatingSaleOrder", isCreatingSaleOrder);
            console.log("currentPath", currentPath);
            console.log("detectedModel", detectedModel);
*/
            if (isCreatingSaleOrder) {
                this.contextService.setContext(currentModel, "form", "create");
            } else if (currentModel) {
                this.contextService.setContext(currentModel, "form", "list");
            }
        }, 500);

        // Limpiar intervalo al desmontar componente
        onWillUnmount(() => {
            if (this.intervalId) {
                clearInterval(this.intervalId);
            }
        });
    }

    //user_activity_tracker test
    addLog(type, data) {
        this.state.logs.push({
            type,
            data,
            timestamp: new Date().toISOString()
        });
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
