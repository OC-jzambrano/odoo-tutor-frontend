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
        el.closest(".offcanvas-backdrop") ||
        el.closest(".ai-floating-button") ||
        el.closest(".ai-owl-trigger") ||
        el.closest("[data-ai-tutor-ignore-event='true']") ||
        el.closest(".o_ai_recorder_panel") ||
        el.closest(".o_ai_picker_overlay") ||
        el.closest(".o_ai_picker_label")
    );
}

export function isModuleEntryNavigationEvent(
    normalized,
    { module = null, moduleRootXmlid = null, el = null } = {}
) {
    const rawTarget = trimText(
        normalized?.meta?.target_name || normalized?.dom?.dom_key || "",
        240
    ).toLowerCase();

    if (
        rawTarget === "btn.home-menu" ||
        el?.closest?.(".o_menu_toggle, .o_navbar_apps_menu > button, .o_navbar_apps_menu > a")
    ) {
        return true;
    }

    const strippedTarget = rawTarget.replace(/^menu\./, "");
    const cleanRootXmlid = trimText(moduleRootXmlid || "", 240).toLowerCase();
    if (cleanRootXmlid && strippedTarget === cleanRootXmlid) {
        return true;
    }

    const cleanModule = trimText(module || "", 120).toLowerCase();
    if (!cleanModule) return false;

    if (
        el?.closest?.(".o_app") &&
        (strippedTarget === cleanModule || strippedTarget.startsWith(`${cleanModule}.`))
    ) {
        return true;
    }

    if (
        strippedTarget === `${cleanModule}.menu_${cleanModule}_root` ||
        strippedTarget === `${cleanModule}.${cleanModule}_menu_root`
    ) {
        return true;
    }

    return false;
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

const KNOWN_ODOO_TARGET_LABELS = Object.freeze({
    "form.save": "Save",
    "form.discard": "Discard",
    "form.create": "New",
    "list.create": "New",
    "kanban.create": "New",
    "form.edit": "Edit",
    execute: "Save",
    cancel: "Discard",
    action_confirm: "Confirm",
    action_cancel: "Cancel",
    action_draft: "Reset to Draft",
    action_post: "Confirm",
    action_validate: "Validate",
    button_validate: "Validate",
    button_confirm: "Confirm",
    button_cancel: "Cancel",
    action_quotation_send: "Send by Email",
    action_create_invoice: "Create Invoice",
    action_register_payment: "Register Payment",
    action_view_invoice: "Invoices",
    action_view_delivery: "Delivery",
    action_archive: "Archive",
    action_unarchive: "Unarchive",
    unlink: "Delete",
});

const KNOWN_ACRONYMS = new Set([
    "API",
    "B2B",
    "B2C",
    "CRM",
    "CSV",
    "ERP",
    "HR",
    "ID",
    "MRP",
    "PDF",
    "PO",
    "POS",
    "RFQ",
    "SKU",
    "SO",
    "URL",
    "VAT",
]);

const SETTINGS_TOGGLE_PREFIX_RE = /^(?:group|module|use|is|has|allow|enable|show|auto)_/i;

function safeCssEscape(value) {
    try {
        if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    } catch {}
    return String(value || "").replace(/["\\]/g, "\\$&");
}

export function isTechnicalKey(value) {
    const text = trimText(value || "", 240);
    if (!text) return false;
    const lower = text.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KNOWN_ODOO_TARGET_LABELS, lower)) {
        return true;
    }
    if (/\s/.test(text)) {
        return false;
    }
    if (
        /^(?:menu|btn|form|list|kanban|button|input|select|textarea|a|div|span)\.[a-z0-9_.-]+$/i.test(
            text
        )
    ) {
        return true;
    }
    if (/^[a-z][a-z0-9]*_[a-z0-9_]+$/i.test(text)) {
        return true;
    }
    if (/^[a-z0-9_]+(?:\.[a-z0-9_-]+)+$/i.test(text)) {
        return true;
    }
    if (/^[a-z]+#[a-z0-9_-]+$/i.test(text)) {
        return true;
    }
    return false;
}

function titleCaseToken(token) {
    const clean = (token || "").trim();
    if (!clean) return "";
    const upper = clean.toUpperCase();
    if (KNOWN_ACRONYMS.has(upper)) return upper;
    return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

export function humanizeTechnicalKey(rawKey, { model = null } = {}) {
    const clean = trimText(rawKey || "", 240);
    if (!clean) return "";

    const lower = clean.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KNOWN_ODOO_TARGET_LABELS, lower)) {
        if (lower === "execute" || lower === "cancel") {
            if (!model || model === "res.config.settings") {
                return KNOWN_ODOO_TARGET_LABELS[lower];
            }
        } else {
            return KNOWN_ODOO_TARGET_LABELS[lower];
        }
    }

    let working = clean;

    // Strip HTML tag prefix like button.action_confirm or input#partner_id_0
    working = working.replace(/^(?:button|input|select|textarea|a|div|span|label)[.#]/i, "");

    // Strip CSS/Odoo button class prefixes
    working = working.replace(/^o_(?:form|list|kanban)_button_/i, "");

    // For menu xmlids like menu.sale.menu_sale_quotations -> menu_sale_quotations
    if (/^menu\./i.test(working)) {
        working = working.replace(/^menu\./i, "");
        const parts = working.split(".").filter(Boolean);
        working = parts[parts.length - 1] || working;
        working = working.replace(/^menu_/i, "");
    } else if (/^btn\./i.test(working)) {
        working = working.replace(/^btn\./i, "");
    } else if (working.includes(".") && !/\s/.test(working)) {
        const parts = working.split(".").filter(Boolean);
        working = parts[parts.length - 1] || working;
    }

    // Strip common Odoo technical prefixes/suffixes
    working = working
        .replace(/^(?:action|button|group|module|field|x_studio|x)_/i, "")
        .replace(/_(?:ids|id)$/i, "")
        .replace(/_\d+$/i, "");

    // Split camelCase, snake_case, kebab-case, dots
    const words = working
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[._-]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (!words.length) return clean;
    return trimText(words.map(titleCaseToken).join(" "), 120);
}

function getLabelTextFromElement(labelEl) {
    if (!labelEl) return "";
    return trimText(labelEl.innerText || labelEl.textContent || "", 120);
}

function resolveAssociatedCheckbox(el) {
    if (!el) return null;
    const tag = (el.tagName || "").toUpperCase();
    const inputType = (el.getAttribute?.("type") || el.type || "").toLowerCase();
    const role = (el.getAttribute?.("role") || "").toLowerCase();

    if (tag === "INPUT" && inputType === "checkbox") {
        return { control: el, viaLabel: false };
    }
    if (role === "checkbox" || role === "switch") {
        return { control: el, viaLabel: false };
    }
    if (tag === "LABEL" || el.closest?.("label")) {
        const labelEl = tag === "LABEL" ? el : el.closest("label");
        const forId = labelEl?.getAttribute?.("for");
        if (forId && labelEl.ownerDocument?.getElementById) {
            const target = labelEl.ownerDocument.getElementById(forId);
            if (
                target &&
                (target.getAttribute?.("type") || target.type || "").toLowerCase() === "checkbox"
            ) {
                return { control: target, viaLabel: true };
            }
        }
        const nested = labelEl?.querySelector?.('input[type="checkbox"]');
        if (nested) {
            return { control: nested, viaLabel: true };
        }
    }
    return null;
}

export function isCheckboxOrToggleTarget(el, normalized = null) {
    if (resolveAssociatedCheckbox(el)) return true;

    const type = normalized?.type || "click";
    if (type === "field_changed") {
        return false;
    }

    const model = trimText(normalized?.meta?.model || "", 240).toLowerCase();
    const fieldOrKey = trimText(normalized?.field || normalized?.meta?.target_name || "", 240);
    if (model === "res.config.settings" && fieldOrKey && SETTINGS_TOGGLE_PREFIX_RE.test(fieldOrKey)) {
        return true;
    }
    if (fieldOrKey && /^(?:group_|module_)/i.test(fieldOrKey) && type !== "menu_clicked") {
        return true;
    }
    return false;
}

function resolveToggleVerb(el, normalized = null) {
    const assoc = resolveAssociatedCheckbox(el);
    if (assoc?.control) {
        const { control, viaLabel } = assoc;
        if (typeof control.checked === "boolean") {
            const nextChecked = viaLabel ? !control.checked : control.checked;
            return nextChecked ? "Enable" : "Disable";
        }
        const ariaChecked = (control.getAttribute?.("aria-checked") || "").toLowerCase();
        if (ariaChecked === "true") return viaLabel ? "Disable" : "Enable";
        if (ariaChecked === "false") return viaLabel ? "Enable" : "Disable";
    }
    if (typeof normalized?.value === "boolean") {
        return normalized.value ? "Enable" : "Disable";
    }
    return "Enable";
}

export function resolveExpectedCheckedState(el, normalized = null) {
    if (!isCheckboxOrToggleTarget(el, normalized)) return null;
    return resolveToggleVerb(el, normalized) === "Enable";
}

export function readElementCheckedState(el) {
    if (!el) return null;
    const assoc = resolveAssociatedCheckbox(el);
    const control =
        assoc?.control ||
        el.querySelector?.('input[type="checkbox"], [role="checkbox"], [role="switch"]') ||
        null;
    if (!control) return null;
    if (typeof control.checked === "boolean") return control.checked;
    const aria = (control.getAttribute?.("aria-checked") || "").toLowerCase();
    if (aria === "true") return true;
    if (aria === "false") return false;
    return null;
}

export function getStepExpectedChecked(step) {
    if (!step || typeof step !== "object") return null;
    if (typeof step.expected_checked === "boolean") {
        return step.expected_checked;
    }
    const instr = trimText(step.instruction || "", 240);
    if (/^(?:enable|activate|check|turn on|activar|habilitar)\b/i.test(instr)) {
        return true;
    }
    if (/^(?:disable|deactivate|uncheck|turn off|desactivar|deshabilitar)\b/i.test(instr)) {
        return false;
    }
    const model = trimText(step.target?.model || "", 240).toLowerCase();
    const key = trimText(step.target?.field || step.target?.target_key || "", 240).toLowerCase();
    if (model === "res.config.settings" && key && SETTINGS_TOGGLE_PREFIX_RE.test(key)) {
        return true;
    }
    return null;
}

function pickCleanLabel(candidate, rawTechnical = "") {
    const clean = trimText(candidate || "", 120);
    if (!clean) return "";
    if (rawTechnical && clean.toLowerCase() === rawTechnical.toLowerCase() && isTechnicalKey(clean)) {
        return "";
    }
    if (isTechnicalKey(clean)) return "";
    return clean;
}

export function resolveDomHumanLabel(el, normalized = null) {
    if (!el) return "";

    const rawTargetName = trimText(normalized?.meta?.target_name || "", 240);
    const rawField = trimText(normalized?.field || "", 240);
    const rawTechnical = rawField || rawTargetName;
    const rawTargetLower = rawTargetName.toLowerCase();

    // Standard Odoo toolbar/form buttons (e.g. icon-only Save button with "Save manually" tooltip).
    if (
        rawTargetLower === "form.save" ||
        rawTargetLower === "form.discard" ||
        rawTargetLower === "list.create" ||
        rawTargetLower === "form.create"
    ) {
        const btn = el.closest?.("button, [role='button'], a.btn") || el;
        const visibleText = pickCleanLabel(btn?.innerText || btn?.textContent || "", rawTargetName);
        if (visibleText && visibleText.length <= 32) {
            return visibleText;
        }
        return KNOWN_ODOO_TARGET_LABELS[rawTargetLower];
    }

    // Interactive button / link / tab / menu item: prefer visible text, then accessible label.
    const interactive = el.closest?.(
        "button, [role='button'], a.btn, [role='tab'], .nav-link, [role='menuitem'], .o_menuitem, .o_app"
    );
    if (interactive) {
        const visibleText = pickCleanLabel(
            interactive.innerText || interactive.textContent || "",
            rawTechnical
        );
        if (visibleText) return visibleText;

        const ariaLabel = pickCleanLabel(interactive.getAttribute?.("aria-label") || "", rawTechnical);
        if (ariaLabel) return ariaLabel;

        const title = pickCleanLabel(
            interactive.getAttribute?.("title") || interactive.getAttribute?.("data-tooltip") || "",
            rawTechnical
        );
        if (title) return title;
    }

    // Field / checkbox / input / setting label resolution.
    const owlWrapper = el.closest?.("[data-odoo-field]");
    if (owlWrapper) {
        const owlLabel = pickCleanLabel(
            owlWrapper.getAttribute?.("data-odoo-field-label") || "",
            owlWrapper.getAttribute?.("data-odoo-field") || rawTechnical
        );
        if (owlLabel) return owlLabel;
    }

    // Native <label for="id"> or element.labels
    if (el.labels?.length) {
        const lbl = pickCleanLabel(getLabelTextFromElement(el.labels[0]), rawTechnical);
        if (lbl) return lbl;
    }
    const elId = el.id || el.getAttribute?.("id");
    if (elId && el.ownerDocument?.querySelector) {
        const forLabel = el.ownerDocument.querySelector(`label[for="${safeCssEscape(elId)}"]`);
        const lbl = pickCleanLabel(getLabelTextFromElement(forLabel), rawTechnical);
        if (lbl) return lbl;
    }

    // Wrapping <label>
    const wrappingLabel = el.closest?.("label");
    if (wrappingLabel) {
        const lbl = pickCleanLabel(getLabelTextFromElement(wrappingLabel), rawTechnical);
        if (lbl) return lbl;
    }

    // Odoo Settings box (.o_setting_box -> .o_setting_right_pane label)
    const settingBox = el.closest?.(".o_setting_box, .o_setting_container, .o_setting_box_content");
    if (settingBox?.querySelector) {
        const settingLabel = settingBox.querySelector(
            ".o_setting_right_pane label.o_form_label, .o_setting_right_pane > label, .o_setting_right_pane .o_form_label, .o_setting_right_pane label, label.o_form_label, label"
        );
        const lbl = pickCleanLabel(getLabelTextFromElement(settingLabel), rawTechnical);
        if (lbl) return lbl;
    }

    // Odoo Form field wrapper (.o_wrap_field -> .o_wrap_label label)
    const wrapField = el.closest?.(".o_wrap_field, .form-check, .o_field_widget");
    if (wrapField?.querySelector) {
        const formLabel = wrapField.querySelector(
            ".o_wrap_label label, label.o_form_label, .form-check-label, label"
        );
        const lbl = pickCleanLabel(getLabelTextFromElement(formLabel), rawTechnical);
        if (lbl) return lbl;
    }

    // Odoo List / One2many table cell -> header column text
    const cell = el.closest?.("td[data-name]");
    const cellField = cell?.dataset?.name || cell?.getAttribute?.("data-name");
    if (cell && cellField) {
        const table = cell.closest?.("table");
        const header = table?.querySelector?.(`thead th[data-name="${safeCssEscape(cellField)}"]`);
        const lbl = pickCleanLabel(getLabelTextFromElement(header), cellField);
        if (lbl) return lbl;
    }

    // Direct attributes on element
    const directCandidates = [
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"),
        el.getAttribute?.("data-tooltip"),
        el.getAttribute?.("placeholder"),
        el.innerText || el.textContent,
    ];
    for (const cand of directCandidates) {
        const lbl = pickCleanLabel(cand, rawTechnical);
        if (lbl) return lbl;
    }

    return "";
}

export function resolveStepHumanLabel(normalized, { el = null } = {}) {
    const rawTargetName = trimText(normalized?.meta?.target_name || "", 240);
    const rawField = trimText(normalized?.field || "", 240);
    const rawTechnical = rawField || rawTargetName;

    // 1. Real DOM label (0 ms direct inspection)
    const domLabel = resolveDomHumanLabel(el, normalized);
    if (domLabel) return domLabel;

    // 2. Human-readable normalized.label (skip if it's still a raw technical key)
    const normLabel = pickCleanLabel(normalized?.label || "", rawTechnical);
    if (normLabel) return normLabel;

    // 3. DOM text preview captured during normalization
    const previewLabel = pickCleanLabel(normalized?.dom?.text_preview || "", rawTechnical);
    if (previewLabel) return previewLabel;

    // 4. Humanize known Odoo keys or raw snake_case/dotted keys
    const fallbackKey =
        rawTargetName ||
        rawField ||
        trimText(normalized?.label || "", 240) ||
        trimText(normalized?.dom?.dom_key || "", 240);
    if (fallbackKey) {
        return humanizeTechnicalKey(fallbackKey, { model: normalized?.meta?.model });
    }

    return "";
}

export function buildStepInstruction(normalized, { el = null } = {}) {
    const label = resolveStepHumanLabel(normalized, { el });
    const type = normalized?.type || "click";

    if (isCheckboxOrToggleTarget(el, normalized)) {
        const verb = resolveToggleVerb(el, normalized);
        return label ? `${verb} ${label}` : `${verb} option`;
    }
    if (type === "field_changed") {
        return label ? `Update ${label}` : "Update field";
    }
    if (type === "menu_clicked") {
        return label ? `Open ${label}` : "Open menu";
    }
    if (type === "tab_changed") {
        if (!label) return "Switch tab";
        return /\btab$/i.test(label) ? `Open ${label}` : `Open ${label} tab`;
    }
    if (type === "card_clicked") {
        return label ? `Open ${label}` : "Open record";
    }
    if (type === "link_clicked" && normalized?.meta?.m2o_action === "select") {
        return label ? `Select ${label}` : "Select option";
    }
    return label ? `Click ${label}` : "Click element";
}

export function buildPickedStepInstruction(picked) {
    if (!picked || typeof picked !== "object") return "Click element";
    const visible = pickCleanLabel(picked.text || picked.title || "", picked.target_key || "");
    if (visible) return `Click ${visible}`;
    const humanized = humanizeTechnicalKey(picked.target_key || picked.name || "");
    return humanized ? `Click ${humanized}` : "Click element";
}

export function buildStepTargetHint(normalized, { el = null, selector = null } = {}) {
    if (!normalized || typeof normalized !== "object") return null;
    const type = normalized.type || "click";
    const rawTargetName = trimText(normalized.meta?.target_name || "", 240);
    const field = trimText(normalized.field || "", 240) || null;
    const label =
        resolveStepHumanLabel(normalized, { el }) ||
        trimText(normalized.label || normalized.dom?.text_preview || "", 120) ||
        null;
    const cleanSelector = trimText(selector || normalized.dom?.selector || "", 240) || null;
    const actionLabel = buildStepInstruction(normalized, { el });

    if (type === "menu_clicked" || rawTargetName.startsWith("menu.")) {
        const xmlid = rawTargetName.replace(/^menu\./, "") || null;
        let menuRole = null;
        if (el?.closest) {
            if (el.closest(".o_app")) {
                menuRole = "app";
            } else if (el.closest(".dropdown-item, .o-dropdown--menu [role='menuitem']")) {
                menuRole = "dropdown_item";
            } else if (
                el.closest(
                    ".dropdown-toggle, .o-dropdown--toggle, [aria-haspopup='menu'], [aria-haspopup='true']"
                ) &&
                !el.closest("a[href]")
            ) {
                menuRole = "dropdown_toggle";
            } else {
                menuRole = "menu_item";
            }
        }
        const hint = {
            kind: "menu",
            field: null,
            name: null,
            xmlid,
            label,
            selector: cleanSelector,
            actionLabel,
        };
        if (menuRole) {
            hint.menu_role = menuRole;
        }
        return hint;
    }

    if (type === "tab_changed") {
        return {
            kind: "tab",
            field: null,
            name: rawTargetName || field || null,
            xmlid: null,
            label,
            selector: cleanSelector,
            actionLabel,
        };
    }

    if (type === "field_changed" || field) {
        return {
            kind: "field",
            field: field || rawTargetName || null,
            name: null,
            xmlid: null,
            label,
            selector: cleanSelector,
            actionLabel,
        };
    }

    if (
        type === "button_clicked" ||
        rawTargetName === "form.save" ||
        rawTargetName === "list.create" ||
        rawTargetName === "form.create" ||
        rawTargetName === "form.discard" ||
        el?.closest?.("button, [role='button'], a.btn")
    ) {
        return {
            kind: "button",
            field: null,
            name: rawTargetName || null,
            xmlid: null,
            label,
            selector: cleanSelector,
            actionLabel,
        };
    }

    if (!cleanSelector && !label) return null;

    return {
        kind: cleanSelector ? "selector" : "button",
        field: null,
        name: rawTargetName || null,
        xmlid: null,
        label,
        selector: cleanSelector,
        actionLabel,
    };
}

function normalizePositiveId(value) {
    if (typeof value === "number") {
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
}

export function buildStepNavSnapshot({
    menuService = null,
    actionService = null,
    contextService = null,
    el = null,
    breadcrumb = "",
} = {}) {
    const currentApp = (() => {
        try {
            return menuService?.getCurrentApp?.() || null;
        } catch {
            return null;
        }
    })();
    const ctrl = actionService?.currentController || null;
    const ctx = (() => {
        try {
            return contextService?.getContext?.() || null;
        } catch {
            return null;
        }
    })();

    const action = ctrl?.action || null;
    const actionId =
        normalizePositiveId(action?.id) ||
        (typeof action?.xml_id === "string" && trimText(action.xml_id, 240)) ||
        null;
    const resModel =
        trimText(
            ctrl?.props?.resModel ||
                action?.res_model ||
                ctrl?.model?.root?.resModel ||
                ctx?.model ||
                "",
            240
        ) || null;
    const viewType =
        trimText(
            ctrl?.props?.viewType ||
                ctrl?.props?.type ||
                ctrl?.view?.type ||
                ctx?.view_type ||
                "",
            60
        ) || null;
    const resId = normalizePositiveId(
        ctrl?.props?.resId ?? ctrl?.model?.root?.resId ?? ctx?.resId ?? null
    );
    const settingsModule =
        resModel === "res.config.settings" && typeof action?.context?.module === "string"
            ? trimText(action.context.module, 120) || null
            : null;
    const inModal = !!el?.closest?.(".modal, .o_dialog");
    const cleanBreadcrumb = trimText(breadcrumb || "", 240) || null;

    return {
        appId: normalizePositiveId(currentApp?.id),
        appXmlid: trimText(currentApp?.xmlid || "", 240) || null,
        appName: trimText(currentApp?.name || "", 120) || null,
        actionId,
        resModel,
        viewType,
        resId,
        settingsModule,
        inModal,
        breadcrumb: cleanBreadcrumb,
    };
}

export function buildStepLocateActionRequest(nav) {
    if (!nav || typeof nav !== "object") return null;

    if (nav.resModel === "res.config.settings") {
        if (nav.actionId) return nav.actionId;
        return {
            type: "ir.actions.act_window",
            res_model: "res.config.settings",
            view_mode: "form",
            views: [[false, "form"]],
            target: "current",
            context: nav.settingsModule ? { module: nav.settingsModule } : {},
        };
    }

    if (nav.resModel && nav.viewType === "form" && nav.resId) {
        return {
            type: "ir.actions.act_window",
            res_model: nav.resModel,
            res_id: nav.resId,
            view_mode: "form",
            views: [[false, "form"]],
            target: "current",
        };
    }

    if (nav.actionId) {
        return nav.actionId;
    }

    if (nav.resModel) {
        const viewType = nav.viewType || "list";
        const views = viewType === "form" ? [[false, "form"]] : [[false, viewType], [false, "form"]];
        return {
            type: "ir.actions.act_window",
            res_model: nav.resModel,
            view_mode: views.map(([, vt]) => vt).join(","),
            views,
            target: "current",
        };
    }

    return null;
}

export function isElementRequiredField(el) {
    if (!el) return false;
    if (el.required === true) return true;
    if (el.hasAttribute?.("required")) return true;
    if ((el.getAttribute?.("aria-required") || "").toLowerCase() === "true") return true;
    if (el.classList?.contains?.("o_required_modifier")) return true;
    if (el.closest?.(".o_required_modifier, .o_field_widget.o_required_modifier")) {
        return true;
    }
    return false;
}

export function buildDraftStepFromEvent(
    normalized,
    { id = null, el = null, module = null, moduleRootXmlid = null, nav = null, selector = null } = {}
) {
    if (!normalized) return null;
    if (isRecorderUiElement(el)) return null;
    if (isSensitiveInputElement(el, normalized)) return null;
    if (isModuleEntryNavigationEvent(normalized, { module, moduleRootXmlid, el })) return null;

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

    const step = {
        id: id || generateUuid(),
        instruction: buildStepInstruction(normalized, { el }),
        target: {
            action,
            model,
            field,
            target_key: targetKey,
        },
        is_optional: false,
        optional_group: null,
    };

    const tag = (el?.tagName || "").toUpperCase();
    const inputType = (el?.getAttribute?.("type") || el?.type || "").toLowerCase();
    const isFieldInput =
        normalized.type === "field_changed" ||
        (["INPUT", "TEXTAREA", "SELECT"].includes(tag) &&
            inputType !== "checkbox" &&
            inputType !== "radio" &&
            model !== "res.config.settings");
    if (isFieldInput && el && !isElementRequiredField(el)) {
        step.suggested_optional = true;
        step.optional_reason = "Non-required field";
    }

    const expectedChecked = resolveExpectedCheckedState(el, normalized);
    if (typeof expectedChecked === "boolean") {
        step.expected_checked = expectedChecked;
    }

    const targetHint = buildStepTargetHint(normalized, { el, selector });
    if (targetHint) {
        step.target_hint = targetHint;
    }
    if (nav && typeof nav === "object") {
        step.nav = nav;
    }

    return step;
}

export function recomputeOptionalGroups(steps = []) {
    const list = Array.isArray(steps) ? steps : [];
    const result = list.map((step) => ({
        ...step,
        is_optional: step?.is_optional === true,
        optional_group: null,
    }));

    let groupCounter = 0;
    let i = 0;
    while (i < result.length) {
        if (!result[i].is_optional) {
            i += 1;
            continue;
        }
        let j = i;
        while (j + 1 < result.length && result[j + 1].is_optional) {
            j += 1;
        }
        if (j > i) {
            groupCounter += 1;
            const groupId = `opt_group_${groupCounter}`;
            for (let k = i; k <= j; k += 1) {
                result[k].optional_group = groupId;
            }
        }
        i = j + 1;
    }
    return result;
}

export function getOptionalBlockRange(steps = [], index = 0) {
    const list = Array.isArray(steps) ? steps : [];
    if (index < 0 || index >= list.length) {
        return { start: index, end: index, count: 0, groupId: null };
    }
    const step = list[index];
    if (!step?.is_optional) {
        return { start: index, end: index, count: 1, groupId: null };
    }
    let start = index;
    let end = index;
    while (start > 0 && list[start - 1]?.is_optional) {
        start -= 1;
    }
    while (end + 1 < list.length && list[end + 1]?.is_optional) {
        end += 1;
    }
    const count = end - start + 1;
    return {
        start,
        end,
        count,
        groupId: count >= 2 ? step.optional_group || `opt_group_${start + 1}` : null,
    };
}

export function getNextIndexAfterSkip(steps = [], currentIndex = 0) {
    const list = Array.isArray(steps) ? steps : [];
    if (currentIndex < 0 || currentIndex >= list.length) return list.length;
    const step = list[currentIndex];
    if (step?.is_optional) {
        const range = getOptionalBlockRange(list, currentIndex);
        if (range.count >= 2) {
            return range.end + 1;
        }
    }
    return currentIndex + 1;
}

export function getPreviousDryRunIndex(steps = [], currentIndex = 0) {
    const list = Array.isArray(steps) ? steps : [];
    const idx = Math.floor(Number(currentIndex) || 0);
    if (!list.length || idx <= 0) return null;
    return Math.min(list.length - 1, idx - 1);
}

export function reconcileDryRunAfterStepRemoval(
    prevSteps = [],
    removedStepIds = [],
    dryRunState = null,
    { fromActivePrompt = false } = {}
) {
    const list = Array.isArray(prevSteps) ? prevSteps : [];
    const idSet = new Set((Array.isArray(removedStepIds) ? removedStepIds : []).filter(Boolean));
    const remainingSteps = recomputeOptionalGroups(
        list.filter((step) => step && !idSet.has(step.id))
    );

    if (!dryRunState?.active) {
        return { steps: remainingSteps, dryRun: null, completed: false };
    }

    if (!remainingSteps.length) {
        return { steps: [], dryRun: null, completed: true };
    }

    const oldIdx = Math.min(
        Math.max(0, list.length - 1),
        Math.max(0, Math.floor(Number(dryRunState.stepIndex) || 0))
    );
    let removedBefore = 0;
    for (let i = 0; i < oldIdx && i < list.length; i += 1) {
        if (list[i] && idSet.has(list[i].id)) {
            removedBefore += 1;
        }
    }

    let nextIdx = Math.max(0, oldIdx - removedBefore);
    if (nextIdx >= remainingSteps.length) {
        if (fromActivePrompt) {
            return { steps: remainingSteps, dryRun: null, completed: true };
        }
        nextIdx = remainingSteps.length - 1;
    }

    const editStepId =
        dryRunState.editStepId && !idSet.has(dryRunState.editStepId)
            ? dryRunState.editStepId
            : null;
    const skippedStillExists =
        dryRunState.skippedPromptStepId && !idSet.has(dryRunState.skippedPromptStepId);
    const skippedIdx = skippedStillExists
        ? remainingSteps.findIndex((s) => s.id === dryRunState.skippedPromptStepId)
        : -1;

    return {
        steps: remainingSteps,
        dryRun: {
            active: true,
            paused: dryRunState.paused === true,
            stepIndex: nextIdx,
            editStepId,
            skippedPromptStepId: skippedIdx >= 0 ? dryRunState.skippedPromptStepId : null,
            skippedPromptStepNumber: skippedIdx >= 0 ? skippedIdx + 1 : null,
        },
        completed: false,
    };
}

export function insertStepsAt(steps = [], newSteps = [], insertIndex = null) {
    const list = Array.isArray(steps) ? steps.slice() : [];
    const incoming = (Array.isArray(newSteps) ? newSteps : [newSteps]).filter(
        (step) => step && typeof step === "object" && step.id
    );
    if (!incoming.length) {
        return { steps: recomputeOptionalGroups(list), insertedIndex: list.length, insertedCount: 0 };
    }

    const existingIds = new Set(list.map((s) => s?.id).filter(Boolean));
    const uniqueIncoming = [];
    for (const step of incoming) {
        if (!existingIds.has(step.id)) {
            existingIds.add(step.id);
            uniqueIncoming.push(step);
        }
    }
    if (!uniqueIncoming.length) {
        return { steps: recomputeOptionalGroups(list), insertedIndex: list.length, insertedCount: 0 };
    }

    const rawIndex =
        insertIndex === null || insertIndex === undefined
            ? list.length
            : Math.floor(Number(insertIndex));
    const clampedIndex = Number.isFinite(rawIndex)
        ? Math.max(0, Math.min(list.length, rawIndex))
        : list.length;

    list.splice(clampedIndex, 0, ...uniqueIncoming);
    return {
        steps: recomputeOptionalGroups(list),
        insertedIndex: clampedIndex,
        insertedCount: uniqueIncoming.length,
    };
}

export function moveStepByOffset(steps = [], stepId = null, delta = 0) {
    const list = Array.isArray(steps) ? steps.slice() : [];
    const offset = Math.trunc(Number(delta) || 0);
    if (!stepId || !offset || list.length < 2) {
        return { steps: list, fromIndex: -1, toIndex: -1, moved: false };
    }
    const fromIndex = list.findIndex((s) => s?.id === stepId);
    if (fromIndex < 0) {
        return { steps: list, fromIndex: -1, toIndex: -1, moved: false };
    }
    const toIndex = Math.max(0, Math.min(list.length - 1, fromIndex + offset));
    if (toIndex === fromIndex) {
        return { steps: list, fromIndex, toIndex, moved: false };
    }
    const [item] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, item);
    return {
        steps: recomputeOptionalGroups(list),
        fromIndex,
        toIndex,
        moved: true,
    };
}

export function captureDeletedStepEntries(steps = [], stepIds = []) {
    const list = Array.isArray(steps) ? steps : [];
    const idSet = new Set((Array.isArray(stepIds) ? stepIds : []).filter(Boolean));
    if (!idSet.size || !list.length) return [];
    const entries = [];
    for (let i = 0; i < list.length; i += 1) {
        if (list[i] && idSet.has(list[i].id)) {
            entries.push({ index: i, step: { ...list[i] } });
        }
    }
    return entries;
}

export function restoreDeletedStepEntries(steps = [], entries = []) {
    const list = Array.isArray(steps) ? steps.slice() : [];
    const validEntries = (Array.isArray(entries) ? entries : [])
        .filter((e) => e && e.step && typeof e.step === "object" && e.step.id)
        .slice()
        .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    if (!validEntries.length) {
        return { steps: recomputeOptionalGroups(list), restoredCount: 0, restoredIds: [] };
    }

    const existingIds = new Set(list.map((s) => s?.id).filter(Boolean));
    const restoredIds = [];
    for (const entry of validEntries) {
        if (existingIds.has(entry.step.id)) continue;
        const targetIndex = Math.max(0, Math.min(list.length, Math.floor(Number(entry.index) || 0)));
        list.splice(targetIndex, 0, entry.step);
        existingIds.add(entry.step.id);
        restoredIds.push(entry.step.id);
    }

    return {
        steps: recomputeOptionalGroups(list),
        restoredCount: restoredIds.length,
        restoredIds,
    };
}

export function reconcileDryRunAfterStepInsertion(
    dryRunState = null,
    insertIndex = 0,
    insertedCount = 1,
    nextStepCount = 0
) {
    if (!dryRunState?.active || insertedCount <= 0 || nextStepCount <= 0) {
        return dryRunState;
    }
    const oldIdx = Math.max(0, Math.floor(Number(dryRunState.stepIndex) || 0));
    const nextIdx =
        insertIndex <= oldIdx
            ? Math.min(nextStepCount - 1, oldIdx + insertedCount)
            : Math.min(nextStepCount - 1, oldIdx);
    const oldSkippedNum = normalizePositiveId(dryRunState.skippedPromptStepNumber);
    const nextSkippedNum =
        oldSkippedNum && insertIndex <= oldSkippedNum - 1
            ? oldSkippedNum + insertedCount
            : oldSkippedNum;
    return {
        ...dryRunState,
        stepIndex: nextIdx,
        skippedPromptStepNumber: nextSkippedNum,
    };
}

export function reconcileDryRunAfterStepMove(dryRunState = null, fromIndex = -1, toIndex = -1) {
    if (!dryRunState?.active || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return dryRunState;
    }
    const oldIdx = Math.max(0, Math.floor(Number(dryRunState.stepIndex) || 0));
    let nextIdx = oldIdx;
    if (oldIdx === fromIndex) {
        nextIdx = toIndex;
    } else if (fromIndex < oldIdx && toIndex >= oldIdx) {
        nextIdx = oldIdx - 1;
    } else if (fromIndex > oldIdx && toIndex <= oldIdx) {
        nextIdx = oldIdx + 1;
    }
    return {
        ...dryRunState,
        stepIndex: nextIdx,
    };
}

function normalizeMatchToken(value) {
    return trimText(value || "", 240).toLowerCase();
}

export function doesEventMatchDraftStep(step, normalized) {
    if (!step || !normalized) return false;
    const target = step.target || {};
    const expectedAction = target.action === "change" ? "change" : "click";
    const eventAction = normalized.type === "field_changed" ? "change" : "click";
    if (expectedAction !== eventAction) return false;

    const expectedModel = normalizeMatchToken(target.model);
    const eventModel = normalizeMatchToken(normalized.meta?.model);
    if (expectedModel && eventModel && expectedModel !== eventModel) {
        return false;
    }

    const expectedField = normalizeMatchToken(target.field);
    const eventField = normalizeMatchToken(normalized.field);
    if (expectedField && eventField && expectedField === eventField) {
        return true;
    }

    const expectedKey = normalizeMatchToken(target.target_key);
    const eventCandidates = [
        normalized.meta?.target_name,
        normalized.field,
        normalized.dom?.dom_key,
        normalized.dom?.selector,
    ]
        .map(normalizeMatchToken)
        .filter(Boolean);

    if (expectedKey && eventCandidates.length) {
        const strippedExpected = expectedKey.replace(/^menu\./, "");
        for (const cand of eventCandidates) {
            if (cand === expectedKey || cand.replace(/^menu\./, "") === strippedExpected) {
                return true;
            }
        }
    }

    const expectedLabel = normalizeMatchToken(step.target_hint?.label);
    const eventLabel = normalizeMatchToken(normalized.label);
    if (expectedLabel && eventLabel && expectedLabel === eventLabel) {
        return true;
    }

    return false;
}

export function matchDryRunStepIndex(steps = [], currentIndex = 0, normalized = null) {
    const list = Array.isArray(steps) ? steps : [];
    if (!normalized || currentIndex < 0 || currentIndex >= list.length) return null;

    if (doesEventMatchDraftStep(list[currentIndex], normalized)) {
        return {
            matchedIndex: currentIndex,
            nextIndex: currentIndex + 1,
            skippedOptionalCount: 0,
        };
    }

    if (list[currentIndex]?.is_optional) {
        let runEnd = currentIndex;
        while (runEnd + 1 < list.length && list[runEnd + 1]?.is_optional) {
            runEnd += 1;
        }
        const maxCheck = Math.min(list.length - 1, runEnd + 1);
        for (let k = currentIndex + 1; k <= maxCheck; k += 1) {
            if (doesEventMatchDraftStep(list[k], normalized)) {
                return {
                    matchedIndex: k,
                    nextIndex: k + 1,
                    skippedOptionalCount: k - currentIndex,
                };
            }
        }
    }

    return null;
}

function isSettingsSaveStep(step) {
    const model = normalizeMatchToken(step?.target?.model);
    if (model !== "res.config.settings") return false;
    const key = normalizeMatchToken(step?.target?.target_key);
    const instr = normalizeMatchToken(step?.instruction);
    return (
        key === "form.save" ||
        key === "execute" ||
        key.includes("save") ||
        /\bsave\b/.test(instr)
    );
}

export function checkDryRunToggleAlreadySatisfied(
    steps = [],
    stepIndex = 0,
    { resolveElement = null, root = null } = {}
) {
    const list = Array.isArray(steps) ? steps : [];
    if (stepIndex < 0 || stepIndex >= list.length || typeof resolveElement !== "function") {
        return null;
    }
    const step = list[stepIndex];
    const expectedChecked = getStepExpectedChecked(step);
    if (typeof expectedChecked !== "boolean") return null;

    const hint =
        step.target_hint ||
        (step.target?.field || step.target?.target_key
            ? {
                  kind: "field",
                  field: step.target?.field || step.target?.target_key,
                  label: step.instruction || null,
              }
            : null);
    if (!hint) return null;

    const el = resolveElement(hint, root);
    if (!el) return null;

    const actualChecked = readElementCheckedState(el);
    if (typeof actualChecked !== "boolean" || actualChecked !== expectedChecked) {
        return null;
    }

    const nextIsSettingsSave =
        stepIndex + 1 < list.length && isSettingsSaveStep(list[stepIndex + 1]);
    return {
        satisfied: true,
        stepId: step.id || null,
        expectedChecked,
        label: expectedChecked ? "Already enabled" : "Already disabled",
        skipSaveStep: !!nextIsSettingsSave,
        nextIndex: nextIsSettingsSave ? stepIndex + 2 : stepIndex + 1,
    };
}

function isSettingsToggleOrControlStep(step) {
    const model = normalizeMatchToken(step?.target?.model);
    if (model !== "res.config.settings") return false;
    return !isSettingsSaveStep(step);
}

function isSettingsMenuNavStep(step) {
    const key = normalizeMatchToken(step?.target?.target_key);
    const instr = normalizeMatchToken(step?.instruction);
    const isMenu =
        key.startsWith("menu.") ||
        step?.target_hint?.kind === "menu" ||
        instr.startsWith("open ");
    if (!isMenu) return false;
    return /(config|setting|ajustes|configuraci)/.test(`${key} ${instr}`);
}

export function detectOptionalBlockSuggestions(steps = []) {
    const list = Array.isArray(steps) ? steps : [];
    const suggestions = [];
    const coveredIndices = new Set();

    for (let i = 0; i < list.length; i += 1) {
        if (coveredIndices.has(i) || !isSettingsSaveStep(list[i])) continue;

        let start = i;
        let hasToggle = false;
        while (start > 0 && isSettingsToggleOrControlStep(list[start - 1])) {
            start -= 1;
            hasToggle = true;
        }
        if (!hasToggle) continue;

        let menuBack = 0;
        while (start > 0 && menuBack < 2 && isSettingsMenuNavStep(list[start - 1])) {
            start -= 1;
            menuBack += 1;
        }

        const blockSteps = list.slice(start, i + 1);
        if (blockSteps.length < 2) continue;
        if (blockSteps.every((s) => s?.is_optional === true)) continue;

        for (let k = start; k <= i; k += 1) coveredIndices.add(k);
        suggestions.push({
            id: `settings_block_${list[start].id}_${list[i].id}`,
            kind: "settings_setup_block",
            startIndex: start,
            endIndex: i,
            stepIds: blockSteps.map((s) => s.id),
            reason: `Setup block — mark Steps ${start + 1}–${i + 1} as Optional (in case already enabled)?`,
        });
    }

    return suggestions;
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

export const EXERCISE_MODULE_ALIASES = Object.freeze({
    account: ["account", "account_accountant"],
    accounting: ["account", "account_accountant"],
    invoicing: ["account", "account_accountant"],
    account_accountant: ["account_accountant", "account"],
    crm: ["crm"],
    stock: ["stock"],
    inventory: ["stock"],
    purchase: ["purchase"],
    purchases: ["purchase"],
    sale: ["sale", "sale_management"],
    sales: ["sale", "sale_management"],
    sale_management: ["sale_management", "sale"],
    mrp: ["mrp"],
    manufacturing: ["mrp"],
    project: ["project"],
    projects: ["project"],
    project_management: ["project"],
    settings: ["base"],
    base: ["base"],
    contacts: ["contacts"],
    hr: ["hr"],
    employees: ["hr"],
    calendar: ["calendar"],
    mail: ["mail"],
    discuss: ["mail"],
    point_of_sale: ["point_of_sale"],
    pos: ["point_of_sale"],
    website: ["website"],
});

export function extractModuleFromApp(app) {
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

export function findAppForModule(apps = [], moduleName = "") {
    const rawTarget = trimText(moduleName, 120).toLowerCase().replaceAll("-", "_");
    if (!rawTarget) return null;
    const appList = Array.isArray(apps) ? apps : [];

    for (const app of appList) {
        if (extractModuleFromApp(app).toLowerCase() === rawTarget) {
            return app;
        }
    }

    const candidates = new Set(EXERCISE_MODULE_ALIASES[rawTarget] || [rawTarget]);
    if (rawTarget.includes(".")) {
        const prefix = rawTarget.split(".")[0];
        if (prefix && !["ir", "res", "web"].includes(prefix)) {
            for (const candidate of EXERCISE_MODULE_ALIASES[prefix] || [prefix]) {
                candidates.add(candidate);
            }
        }
    }

    for (const candidate of candidates) {
        for (const app of appList) {
            if (extractModuleFromApp(app).toLowerCase() === candidate) {
                return app;
            }
        }
    }
    return null;
}

export function extractNavigateToModule(payload) {
    if (!payload || typeof payload !== "object") return null;
    const candidates = [
        payload.navigate_to_module,
        payload.raw?.navigate_to_module,
        payload.result?.navigate_to_module,
        payload.data?.navigate_to_module,
    ];
    for (const candidate of candidates) {
        const cleaned = trimText(candidate || "", 120).toLowerCase();
        if (cleaned) return cleaned;
    }
    return null;
}

export function shouldSuppressModuleGatePrompt(payload, redirected) {
    if (!redirected || !payload || typeof payload !== "object") return false;
    const mode = trimText(
        payload.mode || payload.raw?.mode || payload.result?.mode || payload.data?.mode || "",
        64
    ).toLowerCase();
    return mode === "module_gate";
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
            const item = {
                id: step.id || generateUuid(),
                instruction,
                target: {
                    action,
                    model: trimText(step?.target?.model || "", 240) || null,
                    field: trimText(step?.target?.field || "", 240) || null,
                    target_key: trimText(step?.target?.target_key || "", 240) || null,
                },
            };
            const label = trimText(step?.target_hint?.label || step?.label || "", 120);
            if (label) {
                item.label = label;
            }
            if (step?.is_optional === true) {
                item.is_optional = true;
            }
            return item;
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

export function hydrateDraftForEditing(draft) {
    if (!draft || typeof draft !== "object") return null;
    const recordingId = trimText(draft.recording_id || "", 128) || generateUuid();
    const title = trimText(draft.title || "", 240);
    const module = trimText(draft.module || "", 240);
    const rawSteps = Array.isArray(draft.steps) ? draft.steps : [];

    const hydratedSteps = rawSteps
        .map((step) => {
            if (!step || typeof step !== "object") return null;
            const instruction = trimText(step.instruction || "", 2000);
            if (!instruction) return null;
            const action = step?.target?.action === "change" ? "change" : "click";
            const model = trimText(step?.target?.model || "", 240) || null;
            const field = trimText(step?.target?.field || "", 240) || null;
            const targetKey = trimText(step?.target?.target_key || "", 240) || null;
            const label = trimText(step.label || step?.target_hint?.label || "", 120) || null;

            let targetHint = null;
            if (targetKey && targetKey.startsWith("menu.")) {
                targetHint = {
                    kind: "menu",
                    field: null,
                    name: null,
                    xmlid: targetKey.slice(5) || null,
                    label: label || instruction,
                    selector: null,
                    actionLabel: instruction,
                };
            } else if (action === "change" || field) {
                targetHint = {
                    kind: "field",
                    field: field || targetKey || null,
                    name: null,
                    xmlid: null,
                    label: label || instruction,
                    selector: null,
                    actionLabel: instruction,
                };
            } else if (targetKey) {
                targetHint = {
                    kind: "button",
                    field: null,
                    name: targetKey,
                    xmlid: null,
                    label: label || instruction,
                    selector: null,
                    actionLabel: instruction,
                };
            }

            const hydrated = {
                id: trimText(step.id || "", 128) || generateUuid(),
                instruction,
                is_optional: step.is_optional === true,
                optional_group: null,
                target: {
                    action,
                    model,
                    field,
                    target_key: targetKey,
                },
            };
            if (targetHint) {
                hydrated.target_hint = targetHint;
            }
            const expectedChecked = getStepExpectedChecked(hydrated);
            if (typeof expectedChecked === "boolean") {
                hydrated.expected_checked = expectedChecked;
            }
            return hydrated;
        })
        .filter(Boolean)
        .slice(0, 200);

    return {
        recordingId,
        title,
        module,
        steps: recomputeOptionalGroups(hydratedSteps),
    };
}

export function buildPolishDraftPayload({ title = "", module = "", steps = [] } = {}) {
    const cleanTitle = trimText(title, 240);
    const cleanModule = trimText(module, 240);
    const validSteps = (Array.isArray(steps) ? steps : [])
        .map((step) => {
            const id = trimText(step?.id || "", 128);
            const instruction = trimText(step?.instruction || "", 2000);
            if (!id || !instruction) return null;
            const action = step?.target?.action === "change" ? "change" : "click";
            const item = {
                id,
                instruction,
                target: {
                    action,
                    model: trimText(step?.target?.model || "", 240) || null,
                    field: trimText(step?.target?.field || "", 240) || null,
                    target_key: trimText(step?.target?.target_key || "", 240) || null,
                },
            };
            const label = trimText(step?.target_hint?.label || "", 120);
            if (label) {
                item.label = label;
            }
            const breadcrumb = trimText(step?.nav?.breadcrumb || "", 240);
            if (breadcrumb) {
                item.breadcrumb = breadcrumb;
            }
            const appName = trimText(step?.nav?.appName || "", 120);
            if (appName) {
                item.app_name = appName;
            }
            if (step?.is_optional === true) {
                item.is_optional = true;
            }
            return item;
        })
        .filter(Boolean)
        .slice(0, 200);

    if (!validSteps.length) {
        throw new Error("Record at least one step before polishing.");
    }

    return {
        title: cleanTitle,
        module: cleanModule,
        steps: validSteps,
    };
}

export function applyPolishedInstructionsToSteps(
    steps = [],
    polishResponse = null,
    { skipStepIds = null } = {}
) {
    const list = Array.isArray(steps) ? steps : [];
    if (!polishResponse || typeof polishResponse !== "object" || !list.length) {
        return { steps: list.slice(), changedCount: 0, flaggedCount: 0 };
    }

    const skipSet = skipStepIds instanceof Set ? skipStepIds : new Set(skipStepIds || []);
    const byId = new Map();
    const byIndex = new Map();

    const rawList = Array.isArray(polishResponse.steps)
        ? polishResponse.steps
        : Array.isArray(polishResponse.polished_steps)
            ? polishResponse.polished_steps
            : null;

    if (rawList) {
        rawList.forEach((entry, idx) => {
            if (typeof entry === "string") {
                const clean = trimText(entry, 2000);
                if (clean) byIndex.set(idx, { instruction: clean, hasSuspectField: false, suspectReason: null });
                return;
            }
            if (!entry || typeof entry !== "object") return;
            const clean = trimText(
                entry.polished_instruction || entry.instruction || entry.text || "",
                2000
            );
            const hasSuspectField = Object.prototype.hasOwnProperty.call(entry, "suspect_reason");
            const suspectReason = trimText(entry.suspect_reason || "", 320) || null;
            if (!clean && !hasSuspectField) return;
            const parsed = { instruction: clean || null, hasSuspectField, suspectReason };
            const entryId = trimText(entry.id || entry.step_id || "", 128);
            if (entryId) {
                byId.set(entryId, parsed);
            } else {
                byIndex.set(idx, parsed);
            }
        });
    } else if (Array.isArray(polishResponse.instructions)) {
        polishResponse.instructions.forEach((entry, idx) => {
            const clean = trimText(typeof entry === "string" ? entry : "", 2000);
            if (clean) byIndex.set(idx, { instruction: clean, hasSuspectField: false, suspectReason: null });
        });
    }

    const canUseIndexFallback = byId.size === 0 && byIndex.size === list.length;
    let changedCount = 0;
    let flaggedCount = 0;

    const updated = list.map((step, idx) => {
        if (!step || typeof step !== "object") {
            return step;
        }
        const entry =
            (step.id && byId.get(step.id)) || (canUseIndexFallback ? byIndex.get(idx) : null);
        if (!entry) {
            return step;
        }

        let mutated = false;
        const nextStep = { ...step };

        if (!skipSet.has(step.id) && entry.instruction && entry.instruction !== step.instruction) {
            changedCount += 1;
            mutated = true;
            nextStep.instruction = entry.instruction;
            nextStep.ai_polished = true;
            if (nextStep.target_hint && typeof nextStep.target_hint === "object") {
                nextStep.target_hint = {
                    ...nextStep.target_hint,
                    actionLabel: entry.instruction,
                };
            }
        }

        if (entry.hasSuspectField) {
            if (entry.suspectReason) {
                if (nextStep.llm_suspect_reason !== entry.suspectReason) {
                    nextStep.llm_suspect_reason = entry.suspectReason;
                    mutated = true;
                }
                const sig = `llm:${entry.suspectReason.toLowerCase()}`;
                const dismissed = Array.isArray(nextStep.dismissed_suspect_keys)
                    ? nextStep.dismissed_suspect_keys
                    : [];
                if (!dismissed.includes(sig)) {
                    flaggedCount += 1;
                }
            } else if (nextStep.llm_suspect_reason) {
                delete nextStep.llm_suspect_reason;
                mutated = true;
            }
        }

        return mutated ? nextStep : step;
    });

    return { steps: updated, changedCount, flaggedCount };
}

export const ACTIVE_RECORDING_STORAGE_KEY = "odoo_tutor.active_recording_session";
export const ACTIVE_RECORDING_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function getRecorderStorageKey({ db = null, uid = null } = {}) {
    const cleanDb = trimText(db || "default_db", 120) || "default_db";
    const cleanUid =
        uid !== null && uid !== undefined && String(uid).trim()
            ? trimText(String(uid), 64)
            : "default_user";
    return `${ACTIVE_RECORDING_STORAGE_KEY}:${cleanDb}:${cleanUid}`;
}

export function sanitizePersistedRecordingSession(
    raw,
    { now = Date.now(), maxAgeMs = ACTIVE_RECORDING_MAX_AGE_MS } = {}
) {
    if (!raw || typeof raw !== "object") return null;
    const status = raw.status === "recording" || raw.status === "paused" ? raw.status : null;
    const sessionId = trimText(raw.sessionId || "", 128);
    if (!status || !sessionId) return null;

    const updatedAt = Number(raw.updatedAt);
    if (
        Number.isFinite(updatedAt) &&
        (updatedAt > now + 60000 || now - updatedAt > maxAgeMs)
    ) {
        return null;
    }

    const steps = recomputeOptionalGroups(
        (Array.isArray(raw.steps) ? raw.steps : [])
            .map((step) => {
                if (!step || typeof step !== "object") return null;
                const id = trimText(step.id || "", 128);
                const instruction = trimText(step.instruction || "", 2000);
                if (!id || !instruction) return null;
                const action = step.target?.action === "change" ? "change" : "click";
                const cleanStep = {
                    id,
                    instruction,
                    target: {
                        action,
                        model: trimText(step.target?.model || "", 240) || null,
                        field: trimText(step.target?.field || "", 240) || null,
                        target_key: trimText(step.target?.target_key || "", 240) || null,
                    },
                    is_optional: step.is_optional === true,
                    optional_group: trimText(step.optional_group || "", 64) || null,
                };
                if (step.suggested_optional === true) {
                    cleanStep.suggested_optional = true;
                    cleanStep.optional_reason = trimText(step.optional_reason || "", 240) || null;
                }
                if (step.optional_suggestion_dismissed === true) {
                    cleanStep.optional_suggestion_dismissed = true;
                }
                if (typeof step.expected_checked === "boolean") {
                    cleanStep.expected_checked = step.expected_checked;
                }
                if (typeof step.llm_suspect_reason === "string") {
                    const cleanSuspect = trimText(step.llm_suspect_reason, 320);
                    if (cleanSuspect) {
                        cleanStep.llm_suspect_reason = cleanSuspect;
                    }
                }
                if (Array.isArray(step.dismissed_suspect_keys) && step.dismissed_suspect_keys.length) {
                    const cleanKeys = step.dismissed_suspect_keys
                        .map((k) => trimText(k, 240))
                        .filter(Boolean)
                        .slice(0, 50);
                    if (cleanKeys.length) {
                        cleanStep.dismissed_suspect_keys = cleanKeys;
                    }
                }
                if (step.target_hint && typeof step.target_hint === "object") {
                    cleanStep.target_hint = {
                        kind: trimText(step.target_hint.kind || "", 32) || "selector",
                        field: trimText(step.target_hint.field || "", 240) || null,
                        name: trimText(step.target_hint.name || "", 240) || null,
                        xmlid: trimText(step.target_hint.xmlid || "", 240) || null,
                        label: trimText(step.target_hint.label || "", 120) || null,
                        selector: trimText(step.target_hint.selector || "", 240) || null,
                        actionLabel: trimText(step.target_hint.actionLabel || "", 160) || null,
                    };
                    const cleanMenuRole = trimText(step.target_hint.menu_role || "", 32);
                    if (cleanMenuRole) {
                        cleanStep.target_hint.menu_role = cleanMenuRole;
                    }
                }
                if (step.nav && typeof step.nav === "object") {
                    cleanStep.nav = {
                        appId: normalizePositiveId(step.nav.appId),
                        appXmlid: trimText(step.nav.appXmlid || "", 240) || null,
                        appName: trimText(step.nav.appName || "", 120) || null,
                        actionId:
                            normalizePositiveId(step.nav.actionId) ||
                            (typeof step.nav.actionId === "string"
                                ? trimText(step.nav.actionId, 240) || null
                                : null),
                        resModel: trimText(step.nav.resModel || "", 240) || null,
                        viewType: trimText(step.nav.viewType || "", 60) || null,
                        resId: normalizePositiveId(step.nav.resId),
                        settingsModule: trimText(step.nav.settingsModule || "", 120) || null,
                        inModal: !!step.nav.inModal,
                        breadcrumb: trimText(step.nav.breadcrumb || "", 240) || null,
                    };
                }
                return cleanStep;
            })
            .filter(Boolean)
            .slice(0, 200)
    );

    const feed = (Array.isArray(raw.feed) ? raw.feed : [])
        .map((item) => {
            if (!item || typeof item !== "object") return null;
            const _id = trimText(item._id || "", 128);
            if (!_id) return null;
            return {
                _id,
                event_type: trimText(item.event_type || "STEP_SAVED", 64) || "STEP_SAVED",
                target: trimText(item.target || "", 240) || "-",
                timestamp: trimText(item.timestamp || "", 64) || null,
                note: trimText(item.note || "", 2000),
            };
        })
        .filter(Boolean)
        .slice(0, 60);

    let dryRun = null;
    if (
        raw.dryRun &&
        typeof raw.dryRun === "object" &&
        raw.dryRun.active === true &&
        steps.length > 0
    ) {
        const clampedIndex = Math.min(
            steps.length - 1,
            Math.max(0, Math.floor(Number(raw.dryRun.stepIndex) || 0))
        );
        dryRun = {
            active: true,
            paused: raw.dryRun.paused === true,
            stepIndex: clampedIndex,
            editStepId: trimText(raw.dryRun.editStepId || "", 128) || null,
            skippedPromptStepId: trimText(raw.dryRun.skippedPromptStepId || "", 128) || null,
            skippedPromptStepNumber: normalizePositiveId(raw.dryRun.skippedPromptStepNumber),
        };
    }

    const sanitized = {
        status,
        sessionId,
        exerciseId: trimText(raw.exerciseId || "", 128) || null,
        title: trimText(raw.title || "", 240),
        module: trimText(raw.module || "", 120),
        moduleRootXmlid: trimText(raw.moduleRootXmlid || "", 240) || null,
        steps,
        feed,
        stepIndex: Math.max(0, Math.floor(Number(raw.stepIndex) || 0)),
        note: trimText(raw.note || "", 2000),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    };
    if (dryRun) {
        sanitized.dryRun = dryRun;
    }
    return sanitized;
}

export function clearPersistedRecordingSession(storage, key) {
    if (!storage || !key) return;
    try {
        storage.removeItem(key);
    } catch {}
}

export function savePersistedRecordingSession(storage, key, state, { now = Date.now() } = {}) {
    if (!storage || !key) return false;
    const sanitized = sanitizePersistedRecordingSession({ ...state, updatedAt: now }, { now });
    if (!sanitized) {
        clearPersistedRecordingSession(storage, key);
        return false;
    }
    try {
        storage.setItem(key, JSON.stringify(sanitized));
        return true;
    } catch {
        return false;
    }
}

export function loadPersistedRecordingSession(
    storage,
    key,
    { now = Date.now(), maxAgeMs = ACTIVE_RECORDING_MAX_AGE_MS } = {}
) {
    if (!storage || !key) return null;
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const sanitized = sanitizePersistedRecordingSession(parsed, { now, maxAgeMs });
        if (!sanitized) {
            storage.removeItem(key);
            return null;
        }
        return sanitized;
    } catch {
        clearPersistedRecordingSession(storage, key);
        return null;
    }
}

export function normalizeExerciseExplorerItem(raw = {}, { source = "exercise" } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const draft = raw.draft && typeof raw.draft === "object" ? raw.draft : raw;
    const id = trimText(
        raw.exercise_id || raw.id || raw.recording_id || draft.recording_id || "",
        128
    );
    const title = trimText(raw.title || draft.title || "", 240);
    if (!id || !title) return null;

    const module = trimText(raw.module || draft.module || "", 120) || "general";
    const rawStatus = trimText(
        raw.status || raw.review_status || (source === "exercise" ? "published" : "draft"),
        48
    ).toLowerCase();
    const status =
        rawStatus === "approved" || rawStatus === "published"
            ? "published"
            : rawStatus === "pending_review"
              ? "pending_review"
              : rawStatus === "rejected"
                ? "rejected"
                : "draft";

    const steps = Array.isArray(raw.steps)
        ? raw.steps
        : Array.isArray(draft.steps)
          ? draft.steps
          : [];
    const stepCount = Number.isFinite(Number(raw.step_count))
        ? Math.max(0, Math.floor(Number(raw.step_count)))
        : steps.length;
    const optionalCount = steps.filter((s) => s?.is_optional === true).length;
    const version = trimText(raw.odoo_version || raw.version || draft.odoo_version || "", 32) || null;
    const authorId = raw.author_id ?? draft.author_id ?? null;
    const updatedAt = trimText(raw.updated_at || raw.created_at || "", 64) || null;

    return {
        id,
        recordingId: trimText(raw.recording_id || draft.recording_id || id, 128),
        title,
        module,
        status,
        version,
        stepCount,
        optionalCount,
        authorId,
        updatedAt,
        steps,
        source,
    };
}

export function filterExercisesForExplorer(
    items = [],
    { query = "", module = "", status = "" } = {}
) {
    const list = Array.isArray(items) ? items : [];
    const cleanQuery = trimText(query || "", 160).toLowerCase();
    const cleanModule = trimText(module || "", 120).toLowerCase();
    const cleanStatus = trimText(status || "", 48).toLowerCase();

    return list.filter((item) => {
        if (!item) return false;
        if (cleanModule && (item.module || "").toLowerCase() !== cleanModule) {
            return false;
        }
        if (cleanStatus && (item.status || "").toLowerCase() !== cleanStatus) {
            return false;
        }
        if (!cleanQuery) return true;
        if ((item.title || "").toLowerCase().includes(cleanQuery)) return true;
        if ((item.module || "").toLowerCase().includes(cleanQuery)) return true;
        if (Array.isArray(item.steps)) {
            return item.steps.some((step) =>
                (step?.instruction || "").toLowerCase().includes(cleanQuery)
            );
        }
        return false;
    });
}

export function extractExerciseExplorerModules(items = []) {
    const modules = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        const mod = trimText(item?.module || "", 120);
        if (mod) modules.add(mod);
    }
    return Array.from(modules).sort((a, b) => a.localeCompare(b));
}
