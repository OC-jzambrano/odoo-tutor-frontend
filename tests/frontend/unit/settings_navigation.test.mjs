import { describe, expect, it, vi } from "vitest";
import {
  openTutorSettings,
  TUTOR_SETTINGS_ACTION,
} from "../../../odoo_tutor/static/src/core/settings_navigation.js";

describe("Tutor quota settings navigation", () => {
  it("opens Odoo's registered General Settings action", () => {
    const actionService = { doAction: vi.fn() };

    openTutorSettings(actionService);

    expect(TUTOR_SETTINGS_ACTION).toBe("base.res_config_setting_act_window");
    expect(actionService.doAction).toHaveBeenCalledWith(
      "base.res_config_setting_act_window",
    );
  });
});
