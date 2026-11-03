import { isBrowserPushRegistrationError } from "./push_error";

import { patch } from "@web/core/utils/patch";
import { WebClient } from "@web/webclient/webclient";

function warnAndDisablePush(error, source) {
    console.warn(`[odoo_tutor] Browser push disabled after ${source} failed:`, error);
}

patch(WebClient.prototype, {
    async _subscribePush(...args) {
        try {
            return await super._subscribePush(...args);
        } catch (error) {
            if (isBrowserPushRegistrationError(error)) {
                warnAndDisablePush(error, "subscription");
                return;
            }
            throw error;
        }
    },

    async _unsubscribePush(...args) {
        try {
            return await super._unsubscribePush(...args);
        } catch (error) {
            if (isBrowserPushRegistrationError(error)) {
                warnAndDisablePush(error, "unsubscription");
                return;
            }
            throw error;
        }
    },

    async pushManager(...args) {
        try {
            return await super.pushManager(...args);
        } catch (error) {
            if (isBrowserPushRegistrationError(error)) {
                warnAndDisablePush(error, "PushManager lookup");
                return null;
            }
            throw error;
        }
    },
});
