import { describe, expect, it } from "vitest";
import {
    applyPolishedInstructionsToSteps,
    buildDraftStepFromEvent,
    buildPickedStepInstruction,
    buildPolishDraftPayload,
    buildRecorderModuleOptions,
    buildRecordingDraftPayload,
    buildStepInstruction,
    buildStepLocateActionRequest,
    buildStepNavSnapshot,
    buildStepTargetHint,
    checkDryRunToggleAlreadySatisfied,
    clearPersistedRecordingSession,
    DEFAULT_ODOO_MODULE_OPTIONS,
    detectOptionalBlockSuggestions,
    extractModuleFromApp,
    findAppForModule,
    getNextIndexAfterSkip,
    getOptionalBlockRange,
    getRecorderStorageKey,
    getStepExpectedChecked,
    humanizeTechnicalKey,
    isElementRequiredField,
    isModuleEntryNavigationEvent,
    isRecorderUiElement,
    isSensitiveInputElement,
    isTechnicalKey,
    loadPersistedRecordingSession,
    matchDryRunStepIndex,
    readElementCheckedState,
    recomputeOptionalGroups,
    reconcileDryRunAfterStepRemoval,
    resolveDomHumanLabel,
    resolveExpectedCheckedState,
    savePersistedRecordingSession,
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

    it("ignores events originating from recorder, sidebar, backdrop, or floating toggle UI", () => {
        const insideSidebar = {
            closest: (sel) => (sel === "#offcanvasAiSidebar" ? {} : null),
        };
        const onBackdrop = {
            closest: (sel) => (sel === ".offcanvas-backdrop" ? {} : null),
        };
        const onFloatingToggle = {
            closest: (sel) => (sel === ".ai-floating-button" ? {} : null),
        };
        const insideApp = {
            closest: () => null,
        };

        expect(isRecorderUiElement(insideSidebar)).toBe(true);
        expect(isRecorderUiElement(onBackdrop)).toBe(true);
        expect(isRecorderUiElement(onFloatingToggle)).toBe(true);
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
        expect(clickStep).toMatchObject({
            id: "11111111-1111-4111-8111-111111111111",
            instruction: "Click Confirm",
            target: {
                action: "click",
                model: "sale.order",
                field: null,
                target_key: "action_confirm",
            },
            target_hint: {
                kind: "button",
                name: "action_confirm",
                label: "Confirm",
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
        expect(changeStep).toMatchObject({
            id: "22222222-2222-4222-8222-222222222222",
            instruction: "Update Customer",
            target: {
                action: "change",
                model: "sale.order",
                field: "partner_id",
                target_key: "partner_id",
            },
            target_hint: {
                kind: "field",
                field: "partner_id",
                label: "Customer",
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

    it("builds sorted deduplicated dropdown options from installed Odoo apps with fallback", () => {
        const options = buildRecorderModuleOptions([
            { name: "Sales", xmlid: "sale.sale_menu_root" },
            { name: "CRM", xmlid: "crm.crm_menu_root" },
            { name: "Inventory", xmlid: "stock.menu_stock_root" },
            { name: "Odoo Tutor", xmlid: "odoo_mentor.menu_odoo_tutor_root" },
            { name: "Apps", xmlid: "base.menu_management" },
            { name: "Settings", xmlid: "base.menu_administration" },
        ]);

        expect(options).toEqual([
            { value: "base", label: "Apps (base)" },
            { value: "crm", label: "CRM" },
            { value: "stock", label: "Inventory (stock)" },
            { value: "sale", label: "Sales (sale)" },
        ]);

        expect(buildRecorderModuleOptions([])).toEqual(DEFAULT_ODOO_MODULE_OPTIONS);
    });

    it("ignores home-menu and selected module root navigation clicks while keeping sub-menus", () => {
        const apps = [
            { id: 10, name: "Inventory", xmlid: "stock.menu_stock_root" },
            { id: 20, name: "Sales", xmlid: "sale.sale_menu_root" },
        ];
        expect(extractModuleFromApp(apps[0])).toBe("stock");
        expect(findAppForModule(apps, "stock")).toEqual(apps[0]);
        expect(findAppForModule(apps, "unknown")).toBeNull();

        expect(
            isModuleEntryNavigationEvent(
                { type: "button_clicked", meta: { target_name: "btn.home-menu" } },
                { module: "stock", moduleRootXmlid: "stock.menu_stock_root" }
            )
        ).toBe(true);

        expect(
            isModuleEntryNavigationEvent(
                { type: "menu_clicked", meta: { target_name: "menu.stock.menu_stock_root" } },
                { module: "stock", moduleRootXmlid: "stock.menu_stock_root" }
            )
        ).toBe(true);

        expect(
            buildDraftStepFromEvent(
                {
                    type: "menu_clicked",
                    label: "Inventory",
                    meta: { target_name: "menu.stock.menu_stock_root" },
                },
                { module: "stock", moduleRootXmlid: "stock.menu_stock_root" }
            )
        ).toBeNull();

        const submenuStep = buildDraftStepFromEvent(
            {
                type: "menu_clicked",
                label: "Operations",
                meta: { target_name: "menu.stock.menu_stock_warehouse_mgmt" },
            },
            {
                id: "55555555-5555-4555-8555-555555555555",
                module: "stock",
                moduleRootXmlid: "stock.menu_stock_root",
            }
        );
        expect(submenuStep).toMatchObject({
            id: "55555555-5555-4555-8555-555555555555",
            instruction: "Open Operations",
            target: {
                action: "click",
                model: null,
                field: null,
                target_key: "menu.stock.menu_stock_warehouse_mgmt",
            },
            target_hint: {
                kind: "menu",
                xmlid: "stock.menu_stock_warehouse_mgmt",
                label: "Operations",
            },
        });
    });

    it("persists and restores active recording sessions across page reloads", () => {
        const store = new Map();
        const storage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        };
        const key = getRecorderStorageKey({ db: "odoo_demo", uid: 2 });
        expect(key).toBe("odoo_tutor.active_recording_session:odoo_demo:2");

        const saved = savePersistedRecordingSession(
            storage,
            key,
            {
                status: "recording",
                sessionId: "66666666-6666-4666-8666-666666666666",
                title: "Activate Customer Addresses",
                module: "sale",
                moduleRootXmlid: "sale.sale_menu_root",
                steps: [
                    {
                        id: "77777777-7777-4777-8777-777777777777",
                        instruction: "Click Save",
                        target: {
                            action: "click",
                            model: "res.config.settings",
                            field: null,
                            target_key: "execute",
                        },
                    },
                ],
                feed: [],
                stepIndex: 1,
                note: "",
            },
            { now: 1_000_000 }
        );
        expect(saved).toBe(true);

        const restored = loadPersistedRecordingSession(storage, key, { now: 1_005_000 });
        expect(restored).toEqual({
            status: "recording",
            sessionId: "66666666-6666-4666-8666-666666666666",
            exerciseId: null,
            title: "Activate Customer Addresses",
            module: "sale",
            moduleRootXmlid: "sale.sale_menu_root",
            steps: [
                {
                    id: "77777777-7777-4777-8777-777777777777",
                    instruction: "Click Save",
                    is_optional: false,
                    optional_group: null,
                    target: {
                        action: "click",
                        model: "res.config.settings",
                        field: null,
                        target_key: "execute",
                    },
                },
            ],
            feed: [],
            stepIndex: 1,
            note: "",
            updatedAt: 1_000_000,
        });

        // Expired sessions are dropped and removed from storage.
        expect(
            loadPersistedRecordingSession(storage, key, {
                now: 1_000_000 + 13 * 60 * 60 * 1000,
            })
        ).toBeNull();
        expect(storage.getItem(key)).toBeNull();

        // Saving an idle state clears any previous entry.
        savePersistedRecordingSession(
            storage,
            key,
            { status: "paused", sessionId: "sess-1", steps: [] },
            { now: 2_000_000 }
        );
        expect(storage.getItem(key)).not.toBeNull();
        expect(
            savePersistedRecordingSession(storage, key, { status: "idle", sessionId: null })
        ).toBe(false);
        expect(storage.getItem(key)).toBeNull();

        // Explicit clear works cleanly.
        savePersistedRecordingSession(
            storage,
            key,
            { status: "recording", sessionId: "sess-2", steps: [] },
            { now: 2_000_000 }
        );
        clearPersistedRecordingSession(storage, key);
        expect(loadPersistedRecordingSession(storage, key, { now: 2_000_000 })).toBeNull();
    });

    it("captures nav metadata and target hints, builds locate actions, and strips nav/target_hint on draft save", () => {
        const nav = buildStepNavSnapshot({
            menuService: {
                getCurrentApp: () => ({
                    id: 99,
                    xmlid: "account.menu_finance",
                    name: "Invoicing",
                }),
            },
            actionService: {
                currentController: {
                    action: {
                        id: 412,
                        res_model: "res.config.settings",
                        context: { module: "account" },
                    },
                    props: { resModel: "res.config.settings", viewType: "form", resId: null },
                },
            },
            el: { closest: () => null },
            breadcrumb: "Configuration / Settings",
        });

        expect(nav).toEqual({
            appId: 99,
            appXmlid: "account.menu_finance",
            appName: "Invoicing",
            actionId: 412,
            resModel: "res.config.settings",
            viewType: "form",
            resId: null,
            settingsModule: "account",
            inModal: false,
            breadcrumb: "Configuration / Settings",
        });

        expect(buildStepLocateActionRequest(nav)).toBe(412);
        expect(
            buildStepLocateActionRequest({
                resModel: "res.partner",
                viewType: "form",
                resId: 42,
                actionId: 100,
            })
        ).toEqual({
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: 42,
            view_mode: "form",
            views: [[false, "form"]],
            target: "current",
        });

        const step = buildDraftStepFromEvent(
            {
                type: "field_changed",
                label: "Customer Addresses",
                field: "group_sale_delivery_address",
                meta: { model: "res.config.settings", target_name: "group_sale_delivery_address" },
            },
            {
                id: "88888888-8888-4888-8888-888888888888",
                nav,
                selector: '[name="group_sale_delivery_address"]',
            }
        );

        expect(step.nav).toEqual(nav);
        expect(step.target_hint).toEqual(
            buildStepTargetHint(
                {
                    type: "field_changed",
                    label: "Customer Addresses",
                    field: "group_sale_delivery_address",
                    meta: {
                        model: "res.config.settings",
                        target_name: "group_sale_delivery_address",
                    },
                },
                { selector: '[name="group_sale_delivery_address"]' }
            )
        );

        // Backend draft payload strips frontend-only nav and target_hint fields.
        const draftPayload = buildRecordingDraftPayload({
            recordingId: "99999999-9999-4999-8999-999999999999",
            title: "Configure addresses",
            module: "account",
            steps: [step],
        });
        expect(draftPayload.steps[0]).toEqual({
            id: "88888888-8888-4888-8888-888888888888",
            instruction: "Update Customer Addresses",
            target: {
                action: "change",
                model: "res.config.settings",
                field: "group_sale_delivery_address",
                target_key: "group_sale_delivery_address",
            },
        });
        expect(draftPayload.steps[0].nav).toBeUndefined();
        expect(draftPayload.steps[0].target_hint).toBeUndefined();
        expect(draftPayload.steps[0].is_optional).toBeUndefined();
        expect(draftPayload.steps[0].optional_group).toBeUndefined();
    });

    it("groups contiguous optional steps, skips whole blocks, and allows jumping to next required step in Dry-Run", () => {
        const rawSteps = [
            {
                id: "s1",
                instruction: "Open Configuration",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_config" },
                is_optional: true,
            },
            {
                id: "s2",
                instruction: "Open Settings",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_general_settings" },
                is_optional: true,
            },
            {
                id: "s3",
                instruction: "Enable Customer Addresses",
                target: { action: "click", model: "res.config.settings", field: "group_delivery_invoice_address", target_key: "group_delivery_invoice_address" },
                is_optional: true,
            },
            {
                id: "s4",
                instruction: "Click Save",
                target: { action: "click", model: "res.config.settings", field: null, target_key: "form.save" },
                is_optional: true,
            },
            {
                id: "s5",
                instruction: "Open Orders",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.sale_order_menu" },
                is_optional: false,
            },
            {
                id: "s6",
                instruction: "Update Phone",
                target: { action: "change", model: "res.partner", field: "phone", target_key: "phone" },
                is_optional: true,
            },
        ];

        const grouped = recomputeOptionalGroups(rawSteps);
        expect(grouped[0].optional_group).toBe("opt_group_1");
        expect(grouped[1].optional_group).toBe("opt_group_1");
        expect(grouped[2].optional_group).toBe("opt_group_1");
        expect(grouped[3].optional_group).toBe("opt_group_1");
        expect(grouped[4].optional_group).toBeNull();
        expect(grouped[5].is_optional).toBe(true);
        expect(grouped[5].optional_group).toBeNull();

        expect(getOptionalBlockRange(grouped, 0)).toEqual({
            start: 0,
            end: 3,
            count: 4,
            groupId: "opt_group_1",
        });

        expect(getNextIndexAfterSkip(grouped, 0)).toBe(4);
        expect(getNextIndexAfterSkip(grouped, 5)).toBe(6);

        const jumpMatch = matchDryRunStepIndex(grouped, 0, {
            type: "menu_clicked",
            label: "Orders",
            meta: { target_name: "menu.sale.sale_order_menu" },
        });
        expect(jumpMatch).toEqual({
            matchedIndex: 4,
            nextIndex: 5,
            skippedOptionalCount: 4,
        });

        const payload = buildRecordingDraftPayload({
            recordingId: "88888888-8888-4888-8888-888888888888",
            title: "Customer Addresses",
            module: "sale",
            steps: grouped,
        });
        expect(Object.keys(payload.steps[0]).sort()).toEqual(["id", "instruction", "target"]);
    });

    it("suggests optional for non-required fields and res.config.settings setup blocks without forcing", () => {
        const optionalInput = {
            tagName: "INPUT",
            type: "text",
            required: false,
            getAttribute: (attr) => (attr === "name" ? "phone" : null),
            hasAttribute: () => false,
            classList: { contains: () => false },
            closest: () => null,
        };
        const requiredInput = {
            tagName: "INPUT",
            type: "text",
            required: false,
            getAttribute: (attr) => (attr === "name" ? "partner_id" : null),
            hasAttribute: () => false,
            classList: { contains: () => false },
            closest: (sel) => (sel.includes("o_required_modifier") ? {} : null),
        };

        expect(isElementRequiredField(optionalInput)).toBe(false);
        expect(isElementRequiredField(requiredInput)).toBe(true);

        const optStep = buildDraftStepFromEvent(
            {
                type: "field_changed",
                label: "Phone",
                field: "phone",
                meta: { model: "res.partner", target_name: "phone" },
            },
            { id: "opt-1", el: optionalInput }
        );
        expect(optStep.is_optional).toBe(false);
        expect(optStep.suggested_optional).toBe(true);
        expect(optStep.optional_reason).toBe("Non-required field");

        const reqStep = buildDraftStepFromEvent(
            {
                type: "field_changed",
                label: "Customer",
                field: "partner_id",
                meta: { model: "sale.order", target_name: "partner_id" },
            },
            { id: "req-1", el: requiredInput }
        );
        expect(reqStep.suggested_optional).toBeUndefined();

        const setupSteps = [
            {
                id: "a1",
                instruction: "Open Configuration",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_config" },
                is_optional: false,
            },
            {
                id: "a2",
                instruction: "Open Settings",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.menu_sale_general_settings" },
                is_optional: false,
            },
            {
                id: "a3",
                instruction: "Click Customer Addresses",
                target: { action: "click", model: "res.config.settings", field: "group_delivery_invoice_address", target_key: "group_delivery_invoice_address" },
                is_optional: false,
            },
            {
                id: "a4",
                instruction: "Click Save",
                target: { action: "click", model: "res.config.settings", field: null, target_key: "form.save" },
                is_optional: false,
            },
        ];
        const suggestions = detectOptionalBlockSuggestions(setupSteps);
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].startIndex).toBe(0);
        expect(suggestions[0].endIndex).toBe(3);
        expect(suggestions[0].stepIds).toEqual(["a1", "a2", "a3", "a4"]);
        expect(suggestions[0].reason).toContain("Steps 1–4");
    });

    it("instantly humanizes raw Odoo keys using real DOM labels and known mappings (Stage 1)", () => {
        expect(isTechnicalKey("form.save")).toBe(true);
        expect(isTechnicalKey("list.create")).toBe(true);
        expect(isTechnicalKey("group_sale_delivery_address")).toBe(true);
        expect(isTechnicalKey("Customer Addresses")).toBe(false);

        expect(humanizeTechnicalKey("form.save")).toBe("Save");
        expect(humanizeTechnicalKey("list.create")).toBe("New");
        expect(humanizeTechnicalKey("action_confirm")).toBe("Confirm");
        expect(humanizeTechnicalKey("partner_id")).toBe("Partner");

        // Icon-only Odoo Save button (form.save -> "Click Save")
        const saveBtn = {
            tagName: "BUTTON",
            innerText: "",
            textContent: "",
            getAttribute: (attr) => (attr === "aria-label" ? "Save manually" : null),
            closest(sel) {
                return sel.split(",").map((s) => s.trim()).includes("button") ? this : null;
            },
        };
        const saveStep = buildDraftStepFromEvent(
            {
                type: "button_clicked",
                label: "form.save",
                field: null,
                meta: { model: "sale.order", target_name: "form.save" },
                dom: { dom_key: "button.form-save", text_preview: "" },
            },
            { id: "h-1", el: saveBtn }
        );
        expect(saveStep.instruction).toBe("Click Save");
        expect(saveStep.target.target_key).toBe("form.save");
        expect(saveStep.target_hint.label).toBe("Save");

        // List New button (list.create -> "Click New")
        expect(
            buildStepInstruction({
                type: "button_clicked",
                label: "list.create",
                field: null,
                meta: { model: "sale.order", target_name: "list.create" },
                dom: { text_preview: "" },
            })
        ).toBe("Click New");

        // Settings checkbox (group_sale_delivery_address -> "Enable Customer Addresses" using real DOM label)
        const settingLabelEl = { innerText: "Customer Addresses", textContent: "Customer Addresses" };
        const settingBoxEl = {
            querySelector: (sel) => (sel.includes("o_setting_right_pane") ? settingLabelEl : null),
        };
        const checkboxEl = {
            tagName: "INPUT",
            type: "checkbox",
            checked: true,
            id: "group_sale_delivery_address_0",
            getAttribute: (attr) => (attr === "type" ? "checkbox" : null),
            closest: (sel) => (sel.includes(".o_setting_box") ? settingBoxEl : null),
        };
        expect(resolveDomHumanLabel(checkboxEl)).toBe("Customer Addresses");
        const enableStep = buildDraftStepFromEvent(
            {
                type: "click",
                label: "group_sale_delivery_address",
                field: "group_sale_delivery_address",
                meta: {
                    model: "res.config.settings",
                    target_name: "group_sale_delivery_address",
                },
            },
            { id: "h-2", el: checkboxEl }
        );
        expect(enableStep.instruction).toBe("Enable Customer Addresses");
        expect(enableStep.target.field).toBe("group_sale_delivery_address");
        expect(enableStep.target_hint.label).toBe("Customer Addresses");

        // Unchecking produces "Disable Customer Addresses"
        const uncheckedEl = { ...checkboxEl, checked: false };
        expect(
            buildStepInstruction(
                {
                    type: "click",
                    label: "group_sale_delivery_address",
                    field: "group_sale_delivery_address",
                    meta: {
                        model: "res.config.settings",
                        target_name: "group_sale_delivery_address",
                    },
                },
                { el: uncheckedEl }
            )
        ).toBe("Disable Customer Addresses");

        // Action button with raw normalized.label ("action_confirm") uses real DOM text
        const confirmBtn = {
            tagName: "BUTTON",
            innerText: "Confirm Order",
            textContent: "Confirm Order",
            getAttribute: () => null,
            closest(sel) {
                return sel.split(",").map((s) => s.trim()).includes("button") ? this : null;
            },
        };
        expect(
            buildStepInstruction(
                {
                    type: "button_clicked",
                    label: "action_confirm",
                    field: null,
                    meta: { model: "sale.order", target_name: "action_confirm" },
                },
                { el: confirmBtn }
            )
        ).toBe("Click Confirm Order");

        // Manual Pick Element humanizer
        expect(
            buildPickedStepInstruction({ target_key: "button.action_confirm", text: "Confirm" })
        ).toBe("Click Confirm");
        expect(
            buildPickedStepInstruction({ target_key: "button.o_form_button_save", text: "" })
        ).toBe("Click Save");
    });

    it("builds a single batched polish payload without raw input values and merges polished instructions safely (Stage 2)", () => {
        const steps = [
            {
                id: "step-1",
                instruction: "Click New",
                target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                target_hint: { kind: "button", label: "New", actionLabel: "Click New" },
                nav: { breadcrumb: "Quotations" },
                is_optional: false,
            },
            {
                id: "step-2",
                instruction: "Update Customer",
                target: { action: "change", model: "sale.order", field: "partner_id", target_key: "partner_id" },
                target_hint: { kind: "field", label: "Customer", actionLabel: "Update Customer" },
                nav: { breadcrumb: "Quotations / New" },
                is_optional: false,
            },
            {
                id: "step-3",
                instruction: "Click Save",
                target: { action: "click", model: "sale.order", field: null, target_key: "form.save" },
                target_hint: { kind: "button", label: "Save", actionLabel: "Click Save" },
                nav: { breadcrumb: "Quotations / New" },
                is_optional: false,
            },
        ];

        const polishPayload = buildPolishDraftPayload({
            title: "  Create a Sales Quotation  ",
            module: " sale ",
            steps,
        });
        expect(polishPayload).toEqual({
            title: "Create a Sales Quotation",
            module: "sale",
            steps: [
                {
                    id: "step-1",
                    instruction: "Click New",
                    target: { action: "click", model: "sale.order", field: null, target_key: "list.create" },
                    label: "New",
                    breadcrumb: "Quotations",
                },
                {
                    id: "step-2",
                    instruction: "Update Customer",
                    target: { action: "change", model: "sale.order", field: "partner_id", target_key: "partner_id" },
                    label: "Customer",
                    breadcrumb: "Quotations / New",
                },
                {
                    id: "step-3",
                    instruction: "Click Save",
                    target: { action: "click", model: "sale.order", field: null, target_key: "form.save" },
                    label: "Save",
                    breadcrumb: "Quotations / New",
                },
            ],
        });

        expect(() => buildPolishDraftPayload({ title: "Empty", module: "sale", steps: [] })).toThrow(
            /at least one step/
        );

        // Merges polished instructions by ID while respecting skipStepIds (manually edited steps)
        const { steps: merged, changedCount } = applyPolishedInstructionsToSteps(
            steps,
            {
                steps: [
                    { id: "step-1", instruction: "Click New to start a new sales quotation." },
                    { id: "step-2", instruction: "Choose the Customer for this quotation." },
                    { id: "step-3", instruction: "Click Save to store the quotation." },
                ],
            },
            { skipStepIds: new Set(["step-2"]) }
        );

        expect(changedCount).toBe(2);
        expect(merged[0].instruction).toBe("Click New to start a new sales quotation.");
        expect(merged[0].ai_polished).toBe(true);
        expect(merged[0].target_hint.actionLabel).toBe("Click New to start a new sales quotation.");
        // step-2 skipped because author manually edited it while polish was in flight
        expect(merged[1].instruction).toBe("Update Customer");
        expect(merged[1].ai_polished).toBeUndefined();
        expect(merged[2].instruction).toBe("Click Save to store the quotation.");
        // Target metadata preserved untouched
        expect(merged[2].target).toEqual(steps[2].target);

        // Index-aligned fallback when backend returns { instructions: [...] }
        const fallbackRes = applyPolishedInstructionsToSteps(steps, {
            instructions: [
                "Click New to create a quotation.",
                "Select a Customer.",
                "Click Save.",
            ],
        });
        expect(fallbackRes.changedCount).toBe(3);
        expect(fallbackRes.steps[1].instruction).toBe("Select a Customer.");
    });

    it("persists and restores active Dry-Run progress across page reloads", () => {
        const store = new Map();
        const storage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        };
        const key = getRecorderStorageKey({ db: "odoo_demo", uid: 2 });

        const saved = savePersistedRecordingSession(
            storage,
            key,
            {
                status: "paused",
                sessionId: "sess-dry-run-1",
                title: "Activate Customer Addresses",
                module: "sale",
                steps: [
                    {
                        id: "d1",
                        instruction: "Click Save",
                        target: { action: "click", model: "res.config.settings", field: null, target_key: "form.save" },
                    },
                    {
                        id: "d2",
                        instruction: "Open Orders",
                        target: { action: "click", model: null, field: null, target_key: "menu.sale.sale_order_menu" },
                    },
                ],
                dryRun: {
                    active: true,
                    paused: false,
                    stepIndex: 1,
                    editStepId: null,
                    skippedPromptStepId: "d1",
                    skippedPromptStepNumber: 1,
                },
            },
            { now: 5_000_000 }
        );
        expect(saved).toBe(true);

        const restored = loadPersistedRecordingSession(storage, key, { now: 5_002_000 });
        expect(restored.dryRun).toEqual({
            active: true,
            paused: false,
            stepIndex: 1,
            editStepId: null,
            skippedPromptStepId: "d1",
            skippedPromptStepNumber: 1,
        });

        // Clamps out-of-range stepIndex safely and omits dryRun once inactive.
        savePersistedRecordingSession(
            storage,
            key,
            {
                status: "paused",
                sessionId: "sess-dry-run-1",
                title: "Activate Customer Addresses",
                module: "sale",
                steps: restored.steps,
                dryRun: { active: true, paused: true, stepIndex: 99, editStepId: "d2" },
            },
            { now: 5_003_000 }
        );
        expect(loadPersistedRecordingSession(storage, key, { now: 5_004_000 }).dryRun).toEqual({
            active: true,
            paused: true,
            stepIndex: 1,
            editStepId: "d2",
            skippedPromptStepId: null,
            skippedPromptStepNumber: null,
        });

        savePersistedRecordingSession(
            storage,
            key,
            {
                status: "paused",
                sessionId: "sess-dry-run-1",
                title: "Activate Customer Addresses",
                module: "sale",
                steps: restored.steps,
                dryRun: null,
            },
            { now: 5_005_000 }
        );
        expect(loadPersistedRecordingSession(storage, key, { now: 5_006_000 }).dryRun).toBeUndefined();
    });

    it("keeps Dry-Run active and aligned when deleting steps in bubble or sidebar mode", () => {
        const steps = [
            { id: "s1", instruction: "Open Configuration", target: { action: "click", model: null, field: null, target_key: "menu.config" } },
            { id: "s2", instruction: "Click Wrong Button", target: { action: "click", model: "sale.order", field: null, target_key: "wrong" } },
            { id: "s3", instruction: "Click New", target: { action: "click", model: "sale.order", field: null, target_key: "list.create" } },
            { id: "s4", instruction: "Click Save", target: { action: "click", model: "sale.order", field: null, target_key: "form.save" } },
        ];

        // 1. Quick-deleting the current middle step (s2 at index 1) advances seamlessly to s3 at index 1.
        const midRes = reconcileDryRunAfterStepRemoval(
            steps,
            ["s2"],
            { active: true, paused: false, stepIndex: 1, editStepId: null, skippedPromptStepId: null, skippedPromptStepNumber: null },
            { fromActivePrompt: true }
        );
        expect(midRes.completed).toBe(false);
        expect(midRes.steps.map((s) => s.id)).toEqual(["s1", "s3", "s4"]);
        expect(midRes.dryRun).toMatchObject({ active: true, paused: false, stepIndex: 1 });
        expect(midRes.steps[midRes.dryRun.stepIndex].id).toBe("s3");

        // 2. Deleting an earlier step (s1 at index 0) while on s3 (index 2) shifts stepIndex to 1 so s3 stays active.
        const earlierRes = reconcileDryRunAfterStepRemoval(
            steps,
            ["s1"],
            { active: true, paused: true, stepIndex: 2, editStepId: "s3", skippedPromptStepId: "s2", skippedPromptStepNumber: 2 }
        );
        expect(earlierRes.completed).toBe(false);
        expect(earlierRes.dryRun).toEqual({
            active: true,
            paused: true,
            stepIndex: 1,
            editStepId: "s3",
            skippedPromptStepId: "s2",
            skippedPromptStepNumber: 1,
        });
        expect(earlierRes.steps[earlierRes.dryRun.stepIndex].id).toBe("s3");

        // 3. Quick-deleting the final step (s4 at index 3) from bubble/chat completes Dry-Run cleanly.
        const lastBubbleRes = reconcileDryRunAfterStepRemoval(
            steps,
            ["s4"],
            { active: true, paused: false, stepIndex: 3 },
            { fromActivePrompt: true }
        );
        expect(lastBubbleRes.completed).toBe(true);
        expect(lastBubbleRes.dryRun).toBeNull();
        expect(lastBubbleRes.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);

        // 4. Deleting the final step from the Recorder list (not active prompt) keeps Dry-Run alive on the new last step.
        const lastSidebarRes = reconcileDryRunAfterStepRemoval(
            steps,
            ["s4"],
            { active: true, paused: true, stepIndex: 3, editStepId: "s4" },
            { fromActivePrompt: false }
        );
        expect(lastSidebarRes.completed).toBe(false);
        expect(lastSidebarRes.dryRun).toMatchObject({ active: true, paused: true, stepIndex: 2, editStepId: null });
    });

    it("records expected_checked for boolean toggles and detects Already enabled during Dry-Run (offering to skip Settings Save)", () => {
        const checkedBox = {
            tagName: "INPUT",
            type: "checkbox",
            checked: true,
            getAttribute: (attr) => (attr === "type" ? "checkbox" : null),
            closest: () => null,
        };
        const uncheckedBox = {
            tagName: "INPUT",
            type: "checkbox",
            checked: false,
            getAttribute: (attr) => (attr === "type" ? "checkbox" : null),
            closest: () => null,
        };

        expect(resolveExpectedCheckedState(checkedBox, { type: "click" })).toBe(true);
        expect(resolveExpectedCheckedState(uncheckedBox, { type: "click" })).toBe(false);
        expect(readElementCheckedState(checkedBox)).toBe(true);
        expect(readElementCheckedState(uncheckedBox)).toBe(false);

        const toggleStep = buildDraftStepFromEvent(
            {
                type: "click",
                label: "Customer Addresses",
                field: "group_delivery_invoice_address",
                meta: { model: "res.config.settings", target_name: "group_delivery_invoice_address" },
            },
            { id: "t1", el: checkedBox }
        );
        expect(toggleStep.expected_checked).toBe(true);
        expect(getStepExpectedChecked(toggleStep)).toBe(true);

        const steps = [
            toggleStep,
            {
                id: "t2",
                instruction: "Click Save",
                target: { action: "click", model: "res.config.settings", field: null, target_key: "form.save" },
            },
            {
                id: "t3",
                instruction: "Open Orders",
                target: { action: "click", model: null, field: null, target_key: "menu.sale.sale_order_menu" },
            },
        ];

        // When checkbox is already checked on screen, Dry-Run detects it and offers Continue (skip Save).
        const satisfied = checkDryRunToggleAlreadySatisfied(steps, 0, {
            resolveElement: () => checkedBox,
        });
        expect(satisfied).toEqual({
            satisfied: true,
            stepId: "t1",
            expectedChecked: true,
            label: "Already enabled",
            skipSaveStep: true,
            nextIndex: 2,
        });

        // When checkbox is NOT yet checked on screen, returns null so user completes the step normally.
        expect(
            checkDryRunToggleAlreadySatisfied(steps, 0, {
                resolveElement: () => uncheckedBox,
            })
        ).toBeNull();

        // Also infers expected_checked from instruction text on older recorded steps without expected_checked.
        expect(
            getStepExpectedChecked({
                id: "legacy-1",
                instruction: "Enable Customer Addresses",
                target: { action: "click", model: "res.config.settings", field: "group_delivery_invoice_address", target_key: "group_delivery_invoice_address" },
            })
        ).toBe(true);
    });
});
