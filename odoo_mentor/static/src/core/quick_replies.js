/* eslint-disable */
/** @odoo-module **/

const ALLOWED_VARIANTS = new Set(["primary", "secondary", "danger"]);

const DEFAULT_SWITCH_REPLIES_EN = [
    { id: "switch", label: "Switch", message: "switch", variant: "primary" },
    { id: "continue", label: "Continue", message: "continue", variant: "secondary" },
    { id: "cancel", label: "Cancel", message: "cancel", variant: "danger" },
];

const DEFAULT_SWITCH_REPLIES_ES = [
    { id: "switch", label: "Cambiar", message: "switch", variant: "primary" },
    { id: "continue", label: "Continuar", message: "continue", variant: "secondary" },
    { id: "cancel", label: "Cancelar", message: "cancel", variant: "danger" },
];

function cleanText(value, maxLen = 240) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function normalizeQuickReplyVariant(variant) {
    const clean = cleanText(variant, 32).toLowerCase();
    return ALLOWED_VARIANTS.has(clean) ? clean : "secondary";
}

export function getQuickReplyVariantClass(variant) {
    return `ai-quick-reply-btn--${normalizeQuickReplyVariant(variant)}`;
}

export function normalizeQuickReplyItem(raw, index = 0) {
    if (!raw || typeof raw !== "object") return null;
    const label = cleanText(raw.label ?? raw.title ?? raw.text ?? "", 80);
    const message = cleanText(raw.message ?? raw.value ?? raw.label ?? "", 240);
    if (!label || !message) return null;
    const id =
        cleanText(raw.id ?? "", 64) ||
        message.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 64) ||
        `quick_reply_${index}`;
    return {
        id,
        label,
        message,
        variant: normalizeQuickReplyVariant(raw.variant),
    };
}

export function extractQuickReplies(payload) {
    if (!payload || typeof payload !== "object") return [];
    const candidates = [
        payload.quick_replies,
        payload.raw?.quick_replies,
        payload.result?.quick_replies,
        payload.data?.quick_replies,
    ];
    for (const list of candidates) {
        if (Array.isArray(list) && list.length) {
            const normalized = list
                .map((item, idx) => normalizeQuickReplyItem(item, idx))
                .filter(Boolean);
            if (normalized.length) {
                return normalized;
            }
        }
    }

    const mode = cleanText(
        payload.mode || payload.raw?.mode || payload.result?.mode || payload.data?.mode || "",
        64
    ).toLowerCase();
    if (mode === "awaiting_exercise_switch") {
        const lang = cleanText(
            payload.lang || payload.raw?.lang || payload.result?.lang || payload.data?.lang || "",
            16
        ).toLowerCase();
        const text = cleanText(
            payload.response || payload.raw?.response || payload.result?.response || "",
            500
        );
        const isSpanish = lang.startsWith("es") || text.includes("¿");
        const defaults = isSpanish ? DEFAULT_SWITCH_REPLIES_ES : DEFAULT_SWITCH_REPLIES_EN;
        return defaults.map((item) => ({ ...item }));
    }

    return [];
}
