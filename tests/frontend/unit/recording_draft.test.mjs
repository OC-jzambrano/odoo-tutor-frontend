import { describe, expect, it } from "vitest";
import {
    buildDraftStepFromEvent,
    buildRecorderModuleOptions,
    buildRecordingDraftPayload,
    clearPersistedRecordingSession,
    DEFAULT_ODOO_MODULE_OPTIONS,
    extractModuleFromApp,
    findAppForModule,
    getRecorderStorageKey,
    isModuleEntryNavigationEvent,
    isRecorderUiElement,
    isSensitiveInputElement,
    loadPersistedRecordingSession,
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
        expect(submenuStep).toEqual({
            id: "55555555-5555-4555-8555-555555555555",
            instruction: "Open Operations",
            target: {
                action: "click",
                model: null,
                field: null,
                target_key: "menu.stock.menu_stock_warehouse_mgmt",
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
});
