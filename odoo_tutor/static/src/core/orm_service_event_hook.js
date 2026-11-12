/* eslint-disable */
/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { registry } from "@web/core/registry";
import "@web/core/orm_plugin";
import {
  buildSuccessfulOrmEvent,
  buildValidationErrorEvent,
} from "./orm_event";

const ormService = registry.category("services").get("orm");

patch(ormService, {
  start(env) {
    const orm = super.start(env);
    const originalCall = orm.call.bind(orm);

    orm.call = async (model, method, args = [], kwargs = {}) => {
      try {
        const result = await originalCall(model, method, args, kwargs);
        const event = buildSuccessfulOrmEvent({ model, method, args, result });
        if (event) {
          env.services.ai_ws?.sendEvent?.({
            type: "ui_event",
            event_name: event.name,
            event_data: event,
          });
        }
        return result;
      } catch (error) {
        const event = buildValidationErrorEvent({ model, method, args, error });
        if (event) {
          env.services.ai_ws?.sendEvent?.({
            type: "ui_event",
            event_name: event.name,
            event_data: event,
          });
        }
        throw error;
      }
    };

    return orm;
  },
});
