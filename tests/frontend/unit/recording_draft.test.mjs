import { describe, expect, it } from "vitest";
import {
    buildDraftStepFromEvent,
    buildRecordingDraftPayload,
    isRecorderUiElement,
    isSensitiveInputElement,
} from "../../../odoo_mentor/static/src/core/recording_draft.js";

describe("recording_draft helpers", () => {
    it("excludes password, autocomplete credential, and sensitive field inputs", () => {
        expect(
            isSensitiveInputElement({
                getAttribute: (attr) => (attr === "type" ? "password" : null),
            })
        ).toBe(true);

        expect(
            isSensitiveInputElement({
                getAttribute: (attr) => (attr === "autocomplete" ? "current-password" : null),
            })
        ).toBe(true);

        expect(
            isSensitiveInputElement(null, {
                field: "llm_api_key",
                meta: { target_name: "llm_api_key" },
            })
        ).toBe(true);

        expect(
            isSensitiveInputElement(
                {
                    getAttribute: (attr) => (attr === "name" ? "partner_id" : "text"),
                },
                { field: "partner_id", meta: { target_name: "partner_id" } }
            )
        ).toBe(false);
    });

    it("ignores events originating from recorder or sidebar UI", () => {
        const insideSidebar = {
            closest: (sel) => (sel === "#offcanvasAiSidebar" ? {} : null),
        };
        const insideApp = {
            closest: () => null,
        };

        expect(isRecorderUiElement(insideSidebar)).toBe(true);
        expect(isRecorderUiElement(insideApp)).toBe(false);
    });

    it("builds draft steps from clicks and committed changes without raw input values", () => {
        const clickStep = buildDraftStepFromEvent(
            {
                type: "button_clicked",
                label: "Confirm",
                field: null,
                meta: { model: "sale.order", target_name: "action_confirm" },
                dom: { dom_key: "button.action_confirm" },
            },
            { id: "11111111-1111-4111-8111-111111111111" }
        );
        expect(clickStep).toEqual({
            id: "11111111-1111-4111-8111-111111111111",
            instruction: "Click Confirm",
            target: {
                action: "click",
                model: "sale.order",
                field: null,
                target_key: "action_confirm",
            },
        });

        const changeStep = buildDraftStepFromEvent(
            {
                type: "field_changed",
                label: "Customer",
                field: "partner_id",
                value: "SuperSecretCustomerInput",
                meta: { model: "sale.order", target_name: "partner_id" },
                dom: { dom_key: "input.partner_id" },
            },
            { id: "22222222-2222-4222-8222-222222222222" }
        );
        expect(changeStep).toEqual({
            id: "22222222-2222-4222-8222-222222222222",
            instruction: "Update Customer",
            target: {
                action: "change",
                model: "sale.order",
                field: "partner_id",
                target_key: "partner_id",
            },
        });
        expect(JSON.stringify(changeStep)).not.toContain("SuperSecretCustomerInput");

        expect(
            buildDraftStepFromEvent({
                type: "field_changed",
                label: "API Token",
                field: "access_token",
                value: "tok_secret_123",
                meta: { model: "res.users", target_name: "access_token" },
            })
        ).toBeNull();
    });

    it("requires title, app/module, and at least one step for draft payload", () => {
        const step = {
            id: "33333333-3333-4333-8333-333333333333",
            instruction: "Click New",
            target: { action: "click", model: "crm.lead", field: null, target_key: "new" },
        };

        expect(() =>
            buildRecordingDraftPayload({ title: " ", module: "crm", steps: [step] })
        ).toThrow(/Title is required/);

        expect(() =>
            buildRecordingDraftPayload({ title: "Create lead", module: "", steps: [step] })
        ).toThrow(/App\/module is required/);

        expect(() =>
            buildRecordingDraftPayload({ title: "Create lead", module: "crm", steps: [] })
        ).toThrow(/at least one step/);

        const payload = buildRecordingDraftPayload({
            recordingId: "44444444-4444-4444-8444-444444444444",
            title: "  Create lead  ",
            module: " crm ",
            steps: [step],
        });
        expect(payload).toEqual({
            recording_id: "44444444-4444-4444-8444-444444444444",
            title: "Create lead",
            module: "crm",
            steps: [step],
        });
    });
});
