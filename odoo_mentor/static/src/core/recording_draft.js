/** @odoo-module **/

const SENSITIVE_FIELD_RE =
    /(?:^|[._-])(password|passwd|pwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key|auth[_-]?key|otp|pin)(?:$|[._-])/i;

const SENSITIVE_AUTOCOMPLETE = new Set([
    "current-password",
    "new-password",
    "one-time-code",
]);

function trimText(value, maxLen) {
    return (value || "").toString().trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function generateUuid() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    const hex = () =>
        Math.floor(Math.random() * 0x10000)
            .toString(16)
            .padStart(4, "0");
    return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

export function isRecorderUiElement(el) {
    if (!el?.closest) return false;
    return !!(
        el.closest("#offcanvasAiSidebar") ||
        el.closest(".o_ai_recorder_panel") ||
        el.closest(".o_ai_picker_overlay") ||
        el.closest(".o_ai_picker_label")
    );
}

export function isSensitiveInputElement(el, normalized = null) {
    if (el) {
        const inputType = (el.getAttribute?.("type") || el.type || "").toLowerCase();
        if (inputType === "password") return true;

        const autocomplete = (el.getAttribute?.("autocomplete") || "").toLowerCase().trim();
        if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true;

        const candidates = [
            el.getAttribute?.("name"),
            el.dataset?.name,
            el.id,
            el.closest?.(".o_field_widget[data-name]")?.dataset?.name,
            el.closest?.("[data-odoo-field]")?.getAttribute?.("data-odoo-field"),
        ];
        if (candidates.some((name) => name && SENSITIVE_FIELD_RE.test(String(name)))) {
            return true;
        }
    }

    if (normalized) {
        const metaCandidates = [
            normalized.field,
            normalized.meta?.target_name,
            normalized.dom?.nameAttr,
            normalized.dom?.dataName,
        ];
        if (metaCandidates.some((name) => name && SENSITIVE_FIELD_RE.test(String(name)))) {
            return true;
        }
    }
    return false;
}

export function buildStepInstruction(normalized) {
    const label = trimText(
        normalized?.label ||
            normalized?.field ||
            normalized?.meta?.target_name ||
            normalized?.dom?.text_preview ||
            "",
        120
    );
    const type = normalized?.type || "click";

    if (type === "field_changed") {
        return label ? `Update ${label}` : "Update field";
    }
    if (type === "menu_clicked") {
        return label ? `Open ${label}` : "Open menu";
    }
    if (type === "tab_changed") {
        return label ? `Open ${label} tab` : "Switch tab";
    }
    if (type === "card_clicked") {
        return label ? `Open ${label}` : "Open record";
    }
    return label ? `Click ${label}` : "Click element";
}

export function buildDraftStepFromEvent(normalized, { id = null, el = null } = {}) {
    if (!normalized) return null;
    if (isRecorderUiElement(el)) return null;
    if (isSensitiveInputElement(el, normalized)) return null;

    const action = normalized.type === "field_changed" ? "change" : "click";
    const model = trimText(normalized.meta?.model || "", 240) || null;
    const field = trimText(normalized.field || "", 240) || null;
    const targetKey =
        trimText(
            normalized.meta?.target_name ||
                normalized.field ||
                normalized.dom?.dom_key ||
                normalized.dom?.selector ||
                "",
            240
        ) || null;

    if (!model && !field && !targetKey) {
        return null;
    }

    return {
        id: id || generateUuid(),
        instruction: buildStepInstruction(normalized),
        target: {
            action,
            model,
            field,
            target_key: targetKey,
        },
    };
}

const EXCLUDED_RECORDER_MODULES = new Set(["odoo_mentor", "odoo_tutor"]);

export const DEFAULT_ODOO_MODULE_OPTIONS = Object.freeze([
    { value: "account", label: "Invoicing / Accounting (account)" },
    { value: "base", label: "Settings (base)" },
    { value: "calendar", label: "Calendar (calendar)" },
    { value: "contacts", label: "Contacts (contacts)" },
    { value: "crm", label: "CRM" },
    { value: "hr", label: "Employees (hr)" },
    { value: "mail", label: "Discuss (mail)" },
    { value: "mrp", label: "Manufacturing (mrp)" },
    { value: "point_of_sale", label: "Point of Sale (point_of_sale)" },
    { value: "project", label: "Project (project)" },
    { value: "purchase", label: "Purchase (purchase)" },
    { value: "sale", label: "Sales (sale)" },
    { value: "stock", label: "Inventory (stock)" },
    { value: "website", label: "Website (website)" },
]);

function extractModuleFromApp(app) {
    if (!app || typeof app !== "object") return "";
    const explicit = trimText(app.module || "", 120);
    if (explicit) return explicit;
    const xmlid = trimText(app.xmlid || "", 240);
    if (xmlid && xmlid.includes(".")) {
        return trimText(xmlid.split(".")[0], 120);
    }
    const name = trimText(app.name || "", 120);
    if (!name) return "";
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

export function buildRecorderModuleOptions(apps = []) {
    const byModule = new Map();
    for (const app of Array.isArray(apps) ? apps : []) {
        const value = extractModuleFromApp(app);
        if (!value || EXCLUDED_RECORDER_MODULES.has(value)) continue;
        const name = trimText(app?.name || "", 120);
        const label =
            name && name.toLowerCase() !== value.toLowerCase()
                ? `${name} (${value})`
                : name || value;
        if (!byModule.has(value)) {
            byModule.set(value, { value, label });
        }
    }
    if (!byModule.size) {
        return DEFAULT_ODOO_MODULE_OPTIONS.map((opt) => ({ ...opt }));
    }
    return Array.from(byModule.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function buildRecordingDraftPayload({ recordingId, title, module, steps }) {
    const cleanTitle = trimText(title, 240);
    const cleanModule = trimText(module, 240);
    if (!cleanTitle) {
        throw new Error("Title is required before saving.");
    }
    if (!cleanModule) {
        throw new Error("App/module is required before saving.");
    }
    const validSteps = (Array.isArray(steps) ? steps : [])
        .map((step) => {
            const instruction = trimText(step?.instruction || "", 2000);
            const action = step?.target?.action === "change" ? "change" : "click";
            if (!instruction) return null;
            return {
                id: step.id || generateUuid(),
                instruction,
                target: {
                    action,
                    model: trimText(step?.target?.model || "", 240) || null,
                    field: trimText(step?.target?.field || "", 240) || null,
                    target_key: trimText(step?.target?.target_key || "", 240) || null,
                },
            };
        })
        .filter(Boolean)
        .slice(0, 200);

    if (!validSteps.length) {
        throw new Error("Record at least one step before saving.");
    }

    return {
        recording_id: recordingId || generateUuid(),
        title: cleanTitle,
        module: cleanModule,
        steps: validSteps,
    };
}
