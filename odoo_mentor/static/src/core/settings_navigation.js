/** @odoo-module **/

export const TUTOR_SETTINGS_ACTION = "base.res_config_setting_act_window";
export const TUTOR_PLANS_URL = "https://odooconcept.com/pricing";
export const TRIAL_QUOTA_EXHAUSTED_MESSAGE =
    "Your trial quota has finished. Get a subscription to continue.";

export function openTutorSettings(actionService) {
    return actionService.doAction(TUTOR_SETTINGS_ACTION);
}

export function openTutorPlans(win = globalThis.window) {
    return win?.open?.(TUTOR_PLANS_URL, "_blank", "noopener,noreferrer") ?? null;
}
