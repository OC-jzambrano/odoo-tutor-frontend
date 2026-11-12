/* eslint-disable */
/** @odoo-module **/
import { proxy } from "@odoo/owl";
import { registry } from "@web/core/registry";

export const contextService = {
  dependencies: [],
  start() {
    const state = proxy({
      currentModel: null,
      view_type: null,
      mode: null,
      resId: null,
      isReady: false,
    });

    return {
      setContext: (model, view_type, mode, resId = null) => {
        state.currentModel = model;
        state.view_type = view_type;
        state.mode = mode;
        state.resId = resId;
        state.isReady = true;
      },
      getContext: () => ({
        model: state.currentModel,
        view_type: state.view_type,
        mode: state.mode,
        resId: state.resId,
      }),
      waitForReady: () =>
        new Promise((resolve) => {
          const check = () => (state.isReady ? resolve() : setTimeout(check, 50));
          check();
        }),
      state,
    };
  },
};

registry.category("services").add("context_service", contextService);
