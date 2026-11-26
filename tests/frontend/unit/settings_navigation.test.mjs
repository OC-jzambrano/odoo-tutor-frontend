import { describe, expect, it, vi } from "vitest";
import {
  openTutorPlans,
  openTutorSettings,
  TRIAL_QUOTA_EXHAUSTED_MESSAGE,
  TUTOR_PLANS_URL,
  TUTOR_SETTINGS_ACTION,
} from "../../../odoo_mentor/static/src/core/settings_navigation.js";

describe("Tutor quota settings navigation", () => {
  it("opens Odoo's registered General Settings action", () => {
    const actionService = { doAction: vi.fn() };

    openTutorSettings(actionService);

    expect(TUTOR_SETTINGS_ACTION).toBe("base.res_config_setting_act_window");
    expect(actionService.doAction).toHaveBeenCalledWith(
      "base.res_config_setting_act_window",
    );
  });

  it("opens the subscription plans URL in a new tab", () => {
    const fakeWindow = { open: vi.fn() };

    openTutorPlans(fakeWindow);

    expect(TUTOR_PLANS_URL).toBe("https://odoo-tutor.odoo.com/pricing");
    expect(TRIAL_QUOTA_EXHAUSTED_MESSAGE).toBe(
      "Your trial quota has finished. Get a subscription to continue.",
    );
    expect(fakeWindow.open).toHaveBeenCalledWith(
      TUTOR_PLANS_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });
});
