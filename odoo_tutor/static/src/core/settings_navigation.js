/** @odoo-module **/

export const TUTOR_SETTINGS_ACTION = "base.res_config_setting_act_window";

export function openTutorSettings(actionService) {
    return actionService.doAction(TUTOR_SETTINGS_ACTION);
}
