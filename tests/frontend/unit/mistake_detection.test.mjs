import { describe, expect, it } from "vitest";
import {
    applyLlmReviewResults,
    buildActiveSuspectWarnings,
    buildLlmReviewRequestPayload,
    detectStepMistakes,
    dismissStepSuspectWarning,
    getStepSuspectWarning,
} from "../../../odoo_mentor/static/src/core/mistake_detection.js";
import {
    applyPolishedInstructionsToSteps,
    buildRecordingDraftPayload,
    buildStepTargetHint,
    matchDryRunStepIndex,
    sanitizePersistedRecordingSession,
} from "../../../odoo_mentor/static/src/core/recording_draft.js";

describe("mistake_detection heuristics and LLM review helpers", () => {
    it("flags dead-end menu switches (Open Menu A immediately followed by Open Menu B)", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Open Accounting",
                target: { action: "click", model: null, field: null, target_key: "menu.account.menu_finance" },
                target_hint: { kind: "menu", xmlid: "account.menu_finance", label: "Accounting" },
            },
            {
                id: "s2",
                instruction: "Open Sales",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.sale_menu_root" },
                target_hint: { kind: "menu", xmlid: "sale.sale_menu_root", label: "Sales" },
            },
            {
                id: "s3",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                target_hint: { kind: "button", name: "list.create", label: "New" },
            },
        ];

        const warnings = detectStepMistakes(steps);
        expect(warnings.s1).toMatchObject({
            source: "heuristic",
            code: "dead_end_menu",
            badge: "Possible extra step",
        });
        expect(warnings.s1.reason).toContain("Accounting");
        expect(warnings.s1.reason).toContain("Sales");
        expect(warnings.s2).toBeUndefined();
        expect(warnings.s3).toBeUndefined();
    });

    it("does NOT flag legitimate parent dropdown toggle -> child dropdown item menu clicks", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Open Configuration",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_config" },
                target_hint: {
                    kind: "menu",
                    xmlid: "sale.menu_sale_config",
                    label: "Configuration",
                    menu_role: "dropdown_toggle",
                },
                nav: { appXmlid: "sale.sale_menu_root", appName: "Sales" },
            },
            {
                id: "s2",
                instruction: "Open Settings",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_general_settings" },
                target_hint: {
                    kind: "menu",
                    xmlid: "sale.menu_sale_general_settings",
                    label: "Settings",
                    menu_role: "dropdown_item",
                },
                nav: { appXmlid: "sale.sale_menu_root", appName: "Sales" },
            },
        ];

        const warnings = detectStepMistakes(steps);
        expect(warnings.s1).toBeUndefined();
        expect(warnings.s2).toBeUndefined();
    });

    it("flags opening one dropdown toggle and immediately switching to another dropdown toggle", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Open Reporting",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_report" },
                target_hint: {
                    kind: "menu",
                    xmlid: "sale.menu_sale_report",
                    label: "Reporting",
                    menu_role: "dropdown_toggle",
                },
            },
            {
                id: "s2",
                instruction: "Open Configuration",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_config" },
                target_hint: {
                    kind: "menu",
                    xmlid: "sale.menu_sale_config",
                    label: "Configuration",
                    menu_role: "dropdown_toggle",
                },
            },
        ];

        const warnings = detectStepMistakes(steps);
        expect(warnings.s1).toMatchObject({
            source: "heuristic",
            code: "dead_end_menu",
        });
        expect(warnings.s2).toBeUndefined();
    });

    it("flags undo/cancel pairs (e.g. Click New followed immediately by Click Discard)", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                target_hint: { kind: "button", name: "list.create", label: "New" },
            },
            {
                id: "s2",
                instruction: "Click Discard",
                target: { action: "click", model: "sale.order", field: null, target_key: "form.discard" },
                target_hint: { kind: "button", name: "form.discard", label: "Discard" },
            },
            {
                id: "s3",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                target_hint: { kind: "button", name: "list.create", label: "New" },
            },
        ];

        const warnings = detectStepMistakes(steps);
        expect(warnings.s1).toMatchObject({
            source: "heuristic",
            code: "undo_cancel_pair",
            pairStepIds: ["s1", "s2"],
        });
        expect(warnings.s2).toMatchObject({
            source: "heuristic",
            code: "undo_cancel_pair",
            pairStepIds: ["s1", "s2"],
        });
        expect(warnings.s3).toBeUndefined();
    });

    it("flags repeated clicks and edits on the exact same button/field back-to-back", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Click Confirm",
                target: { action: "click", model: "sale.order", field: null, target_key: "action_confirm" },
                target_hint: { kind: "button", name: "action_confirm", label: "Confirm" },
            },
            {
                id: "s2",
                instruction: "Click Confirm",
                target: { action: "click", model: "sale.order", field: null, target_key: "action_confirm" },
                target_hint: { kind: "button", name: "action_confirm", label: "Confirm" },
            },
            {
                id: "s3",
                instruction: "Update Customer",
                target: { action: "change", model: "sale.order", field: "partner_id", target_key: "partner_id" },
                target_hint: { kind: "field", field: "partner_id", label: "Customer" },
            },
            {
                id: "s4",
                instruction: "Update Customer",
                target: { action: "change", model: "sale.order", field: "partner_id", target_key: "partner_id" },
                target_hint: { kind: "field", field: "partner_id", label: "Customer" },
            },
        ];

        const warnings = detectStepMistakes(steps);
        expect(warnings.s1).toBeUndefined();
        expect(warnings.s2).toMatchObject({
            source: "heuristic",
            code: "repeated_action",
        });
        expect(warnings.s2.reason).toContain("Repeated click");
        expect(warnings.s3).toBeUndefined();
        expect(warnings.s4).toMatchObject({
            source: "heuristic",
            code: "repeated_action",
        });
        expect(warnings.s4.reason).toContain("Repeated edit");
    });

    it("applies LLM polished_instruction and suspect_reason without silently deleting steps", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Open Accounting",
                target: { action: "click", model: null, field: null, target_key: "menu.account.menu_finance" },
                nav: { breadcrumb: "Accounting", appName: "Accounting" },
            },
            {
                id: "s2",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                nav: { breadcrumb: "Sales / Quotations", appName: "Sales" },
            },
        ];

        const req = buildLlmReviewRequestPayload({
            recordingId: "rec-1",
            title: "Create quotation",
            module: "sale",
            steps,
        });
        expect(req.steps).toHaveLength(2);
        expect(req.steps[0]).toMatchObject({
            id: "s1",
            breadcrumb: "Accounting",
            app_name: "Accounting",
        });

        const applied = applyLlmReviewResults(steps, {
            steps: [
                {
                    id: "s1",
                    polished_instruction: "Open the Accounting app",
                    suspect_reason: "Opened Accounting menu right before switching to Sales — likely unnecessary",
                },
                {
                    id: "s2",
                    polished_instruction: "Click New to create a quotation",
                    suspect_reason: null,
                },
            ],
        });

        expect(applied.steps).toHaveLength(2);
        expect(applied.polishedCount).toBe(2);
        expect(applied.flaggedCount).toBe(1);
        expect(applied.steps[0].instruction).toBe("Open the Accounting app");
        expect(applied.steps[0].llm_suspect_reason).toBe(
            "Opened Accounting menu right before switching to Sales — likely unnecessary"
        );
        expect(applied.steps[1].instruction).toBe("Click New to create a quotation");
        expect(applied.steps[1].llm_suspect_reason).toBeUndefined();

        const active = buildActiveSuspectWarnings(applied.steps);
        expect(active.s1).toMatchObject({
            source: "llm",
            code: "llm_suspect",
            reason: "Opened Accounting menu right before switching to Sales — likely unnecessary",
        });
        expect(active.s2).toBeUndefined();
    });

    it("respects author Keep decision via dismissStepSuspectWarning without hiding future distinct LLM reasons", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Click Confirm",
                target: { action: "click", model: "sale.order", field: null, target_key: "action_confirm" },
            },
            {
                id: "s2",
                instruction: "Click Confirm",
                target: { action: "click", model: "sale.order", field: null, target_key: "action_confirm" },
            },
        ];

        const initialWarnings = buildActiveSuspectWarnings(steps);
        expect(initialWarnings.s2).toBeTruthy();

        const keptSteps = dismissStepSuspectWarning(steps, "s2", initialWarnings.s2.signature);
        expect(buildActiveSuspectWarnings(keptSteps).s2).toBeUndefined();

        // A later LLM review with a distinct reason should still surface for author review.
        const llmApplied = applyLlmReviewResults(keptSteps, {
            steps: [
                {
                    id: "s2",
                    polished_instruction: "Click Confirm",
                    suspect_reason: "Duplicate confirmation click after order is already confirmed",
                },
            ],
        });
        const warning = getStepSuspectWarning(llmApplied.steps[1], detectStepMistakes(llmApplied.steps));
        expect(warning).toMatchObject({
            source: "llm",
            reason: "Duplicate confirmation click after order is already confirmed",
        });
    });

    it("captures menu_role, persists suspect metadata across reloads, strips it on save, and dry-runs remaining steps end-to-end", () => {
        const dropdownHint = buildStepTargetHint(
            {
                type: "menu_clicked",
                label: "Configuration",
                meta: { target_name: "menu.sale.menu_sale_config" },
            },
            {
                el: {
                    closest: (sel) => (sel.includes(".dropdown-toggle") ? {} : null),
                },
            }
        );
        expect(dropdownHint.menu_role).toBe("dropdown_toggle");

        const itemHint = buildStepTargetHint(
            {
                type: "menu_clicked",
                label: "Settings",
                meta: { target_name: "menu.sale.menu_sale_general_settings" },
            },
            {
                el: {
                    closest: (sel) => (sel.includes(".dropdown-item") ? {} : null),
                },
            }
        );
        expect(itemHint.menu_role).toBe("dropdown_item");

        const persisted = sanitizePersistedRecordingSession({
            status: "paused",
            sessionId: "sess-mistake-1",
            title: "Create quotation",
            module: "sale",
            steps: [
                {
                    id: "s1",
                    instruction: "Open Accounting",
                    target: { action: "click", model: null, field: null, target_key: "menu.account.menu_finance" },
                    llm_suspect_reason: "Opened Accounting right before Sales",
                    dismissed_suspect_keys: ["heuristic:dead_end_menu:s1:s2"],
                    target_hint: dropdownHint,
                },
                {
                    id: "s2",
                    instruction: "Click New",
                    target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                },
            ],
            updatedAt: Date.now(),
        });

        expect(persisted.steps[0].llm_suspect_reason).toBe("Opened Accounting right before Sales");
        expect(persisted.steps[0].dismissed_suspect_keys).toEqual(["heuristic:dead_end_menu:s1:s2"]);
        expect(persisted.steps[0].target_hint.menu_role).toBe("dropdown_toggle");

        // Removing the flagged extra step leaves only the clean step, which passes Dry-Run and strips review metadata on save.
        const remaining = persisted.steps.filter((s) => s.id !== "s1");
        const dryRunMatch = matchDryRunStepIndex(remaining, 0, {
            type: "button_clicked",
            label: "New",
            meta: { model: "sale.order", target_name: "list.create" },
        });
        expect(dryRunMatch).toEqual({
            matchedIndex: 0,
            nextIndex: 1,
            skippedOptionalCount: 0,
        });

        const savedDraft = buildRecordingDraftPayload({
            recordingId: "11111111-1111-4111-8111-111111111111",
            title: "Create quotation",
            module: "sale",
            steps: persisted.steps,
        });
        expect(savedDraft.steps[0].llm_suspect_reason).toBeUndefined();
        expect(savedDraft.steps[0].dismissed_suspect_keys).toBeUndefined();
    });

    it("bundles polished_instruction and suspect_reason inside applyPolishedInstructionsToSteps", () => {
        const steps = [
            {
                id: "s1",
                instruction: "Open Accounting",
                target: { action: "click", model: null, field: null, target_key: "menu.account.menu_finance" },
            },
            {
                id: "s2",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
            },
        ];

        const result = applyPolishedInstructionsToSteps(steps, {
            steps: [
                {
                    id: "s1",
                    polished_instruction: "Open the Accounting menu",
                    suspect_reason: "Opened Accounting menu right before switching to Sales — likely unnecessary",
                },
                {
                    id: "s2",
                    polished_instruction: "Click New to create a quotation",
                    suspect_reason: null,
                },
            ],
        });

        expect(result.changedCount).toBe(2);
        expect(result.flaggedCount).toBe(1);
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].instruction).toBe("Open the Accounting menu");
        expect(result.steps[0].llm_suspect_reason).toBe(
            "Opened Accounting menu right before switching to Sales — likely unnecessary"
        );
        expect(result.steps[1].instruction).toBe("Click New to create a quotation");
        expect(result.steps[1].llm_suspect_reason).toBeUndefined();

        const active = buildActiveSuspectWarnings(result.steps);
        expect(active.s1).toMatchObject({
            source: "llm",
            reason: "Opened Accounting menu right before switching to Sales — likely unnecessary",
        });
        expect(active.s2).toBeUndefined();
    });
});
