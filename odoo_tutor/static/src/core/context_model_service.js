/* eslint-disable */
/** @odoo-module **/
import {reactive} from "@odoo/owl";
import {registry} from "@web/core/registry";

export const contextService = {
    dependencies: [],
    start() {
        const state = reactive({
            currentModel: null,
            view: null,
            mode: null,
            isReady: false,
        });

        // Retorna la API del servicio (NO registrar aquí)
        return {
            setContext: (model, view, mode) => {
                state.currentModel = model;
                state.view = view;
                state.mode = mode;
                state.isReady = true;
            },
            getContext: () => ({
                model: state.currentModel,
                view: state.view,
                mode: state.mode,
            }),
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
