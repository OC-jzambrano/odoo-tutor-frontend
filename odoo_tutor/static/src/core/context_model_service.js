/* eslint-disable */
/** @odoo-module **/
import {reactive} from "@odoo/owl";
import {registry} from "@web/core/registry";

export const contextService = {
    dependencies: [],
    start() {
        const state = reactive({
            currentModel: null,
            isReady: false,
        });

        // Retorna la API del servicio (NO registrar aquí)
        return {
            setContext: (model) => {
                state.currentModel = model;
                state.isReady = true;
            },
            getContext: () => ({model: state.currentModel}),
            waitForReady: () =>
                new Promise((resolve) => {
                    const check = () =>
                        state.isReady ? resolve() : setTimeout(check, 50);
                    check();
                }),
            state,
        };
    },
};

// Registra el PROVEEDOR del servicio (fuera de start)
registry.category("services").add("context_service", contextService);
