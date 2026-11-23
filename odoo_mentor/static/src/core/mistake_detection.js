/** @odoo-module **/

function trimText(value, maxLen = 240) {
    return (value || "").toString().trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function normalizeToken(value) {
    return trimText(value, 240).toLowerCase();
}

function getStepLabel(step) {
    const label = trimText(
        step?.target_hint?.label ||
            step?.instruction ||
            step?.target?.field ||
            step?.target?.target_key ||
            "",
        80
    );
    return label || "this element";
}

function isMenuStep(step) {
    if (!step || typeof step !== "object") return false;
    const action = step.target?.action === "change" ? "change" : "click";
    if (action !== "click") return false;
    if (step.target_hint?.kind === "menu") return true;
    const key = normalizeToken(step.target?.target_key);
    if (key.startsWith("menu.")) return true;
    const xmlid = normalizeToken(step.target_hint?.xmlid);
    if (xmlid) return true;
    return false;
}

function getMenuIdentity(step) {
    const xmlid = normalizeToken(step?.target_hint?.xmlid);
    if (xmlid) return `menu:${xmlid}`;
    const key = normalizeToken(step?.target?.target_key);
    if (key) return `menu:${key.replace(/^menu\./, "")}`;
    const label = normalizeToken(step?.target_hint?.label || step?.instruction);
    return label ? `menu_label:${label}` : "";
}

function isLegitimateDropdownParentChild(prevStep, nextStep) {
    const prevRole = normalizeToken(prevStep?.target_hint?.menu_role);
    const nextRole = normalizeToken(nextStep?.target_hint?.menu_role);
    if (prevRole !== "dropdown_toggle" || nextRole !== "dropdown_item") {
        return false;
    }
    const prevApp = normalizeToken(prevStep?.nav?.appXmlid || prevStep?.nav?.appName);
    const nextApp = normalizeToken(nextStep?.nav?.appXmlid || nextStep?.nav?.appName);
    if (prevApp && nextApp && prevApp !== nextApp) {
        return false;
    }
    return true;
}

const CANCEL_TARGET_KEYS = new Set([
    "form.discard",
    "o_form_button_cancel",
    "cancel",
    "discard",
    "action_cancel",
    "btn.discard",
    "btn.cancel",
]);

const UNDOABLE_START_KEYS = new Set([
    "list.create",
    "form.create",
    "o_list_button_add",
    "o_form_button_create",
    "action_create",
    "btn.new",
    "btn.create",
    "btn.edit",
]);

const CANCEL_TEXT_RE = /\b(discard|cancel|descartar|cancelar)\b/i;
const UNDOABLE_START_TEXT_RE = /\b(new|create|nuevo|crear|edit|editar|add a line|add a section|add a note)\b/i;

function isCancelOrDiscardStep(step) {
    if (!step || typeof step !== "object") return false;
    const action = step.target?.action === "change" ? "change" : "click";
    if (action !== "click") return false;
    if (isMenuStep(step)) return false;

    const key = normalizeToken(step.target?.target_key);
    if (CANCEL_TARGET_KEYS.has(key)) return true;

    const hintName = normalizeToken(step.target_hint?.name);
    if (CANCEL_TARGET_KEYS.has(hintName)) return true;

    const text = [step.target_hint?.label, step.instruction]
        .map((v) => trimText(v, 120))
        .filter(Boolean)
        .join(" ");
    if (!text) return false;

    // Avoid matching non-button elements with unrelated labels unless clearly a button/click.
    if (step.target_hint?.kind === "field" || step.target_hint?.kind === "tab") {
        return false;
    }
    return CANCEL_TEXT_RE.test(text);
}

function isUndoableStartStep(step) {
    if (!step || typeof step !== "object") return false;
    const action = step.target?.action === "change" ? "change" : "click";
    if (action !== "click") return false;
    if (isMenuStep(step) || isCancelOrDiscardStep(step)) return false;

    const key = normalizeToken(step.target?.target_key);
    if (UNDOABLE_START_KEYS.has(key)) return true;

    const hintName = normalizeToken(step.target_hint?.name);
    if (UNDOABLE_START_KEYS.has(hintName)) return true;

    if (step.target_hint?.kind === "field" || step.target_hint?.kind === "tab") {
        return false;
    }

    const text = [step.target_hint?.label, step.instruction]
        .map((v) => trimText(v, 120))
        .filter(Boolean)
        .join(" ");
    return !!text && UNDOABLE_START_TEXT_RE.test(text);
}

const GENERIC_TARGET_TOKENS = new Set([
    "",
    "-",
    "unknown",
    "button",
    "input",
    "a",
    "div",
    "span",
    "el",
]);

function getStepTargetIdentity(step) {
    if (!step || typeof step !== "object") return null;
    const action = step.target?.action === "change" ? "change" : "click";
    const model = normalizeToken(step.target?.model);

    let token = "";
    if (isMenuStep(step)) {
        token = getMenuIdentity(step);
    } else {
        const candidates = [
            step.target?.field,
            step.target?.target_key,
            step.target_hint?.field,
            step.target_hint?.name,
            step.target_hint?.selector,
        ];
        for (const candidate of candidates) {
            const norm = normalizeToken(candidate);
            if (norm && !GENERIC_TARGET_TOKENS.has(norm)) {
                token = norm;
                break;
            }
        }
    }

    if (!token) return null;
    return { action, model, token };
}

function areSameTargetBackToBack(prevStep, nextStep) {
    const prevId = getStepTargetIdentity(prevStep);
    const nextId = getStepTargetIdentity(nextStep);
    if (!prevId || !nextId) return false;
    if (prevId.action !== nextId.action) return false;
    if (prevId.model && nextId.model && prevId.model !== nextId.model) {
        return false;
    }
    return prevId.token === nextId.token;
}

/**
 * Run instant, zero-cost frontend heuristics over recorded steps to flag
 * probable slip-ups without ever deleting anything automatically.
 *
 * Returns a plain object mapping step.id -> warning descriptor:
 *   {
 *     source: "heuristic",
 *     code: "dead_end_menu" | "undo_cancel_pair" | "repeated_action",
 *     signature: string,
 *     badge: "Possible extra step",
 *     reason: string,
 *     pairStepIds?: [string, string],
 *   }
 */
export function detectStepMistakes(steps = []) {
    const list = Array.isArray(steps) ? steps.filter((s) => s && s.id) : [];
    const warningsById = {};

    const assignWarning = (stepId, warning) => {
        if (!stepId || warningsById[stepId]) return;
        warningsById[stepId] = warning;
    };

    for (let i = 0; i < list.length - 1; i += 1) {
        const current = list[i];
        const next = list[i + 1];

        // 1. Undo / cancel pair (e.g. Click New -> Click Discard)
        if (isUndoableStartStep(current) && isCancelOrDiscardStep(next)) {
            const pairStepIds = [current.id, next.id];
            const currentLabel = getStepLabel(current);
            const nextLabel = getStepLabel(next);
            assignWarning(current.id, {
                source: "heuristic",
                code: "undo_cancel_pair",
                signature: `heuristic:undo_cancel_pair:${current.id}:${next.id}`,
                badge: "Possible extra step",
                reason: `Immediately undone by "${nextLabel}".`,
                pairStepIds,
            });
            assignWarning(next.id, {
                source: "heuristic",
                code: "undo_cancel_pair",
                signature: `heuristic:undo_cancel_pair:${next.id}:${current.id}`,
                badge: "Possible extra step",
                reason: `Cancels previous step "${currentLabel}".`,
                pairStepIds,
            });
            continue;
        }

        // 2. Repeated click or edit on the exact same button/field back-to-back
        if (areSameTargetBackToBack(current, next)) {
            const label = getStepLabel(next);
            const isChange = next.target?.action === "change";
            assignWarning(next.id, {
                source: "heuristic",
                code: "repeated_action",
                signature: `heuristic:repeated_action:${current.id}:${next.id}`,
                badge: "Possible extra step",
                reason: isChange
                    ? `Repeated edit on "${label}" back-to-back.`
                    : `Repeated click on "${label}" back-to-back.`,
            });
            continue;
        }

        // 3. Dead-end menu switch: Open Menu A immediately followed by Open Menu B
        if (
            isMenuStep(current) &&
            isMenuStep(next) &&
            getMenuIdentity(current) !== getMenuIdentity(next) &&
            !isLegitimateDropdownParentChild(current, next)
        ) {
            const labelA = getStepLabel(current);
            const labelB = getStepLabel(next);
            assignWarning(current.id, {
                source: "heuristic",
                code: "dead_end_menu",
                signature: `heuristic:dead_end_menu:${current.id}:${next.id}`,
                badge: "Possible extra step",
                reason: `Opened "${labelA}" right before switching to "${labelB}" with no action inside.`,
            });
        }
    }

    return warningsById;
}

/**
 * Return the active (non-dismissed) suspect warning for a step, preferring an
 * LLM suspect_reason when available and falling back to frontend heuristics.
 */
export function getStepSuspectWarning(step, heuristicWarningsById = {}) {
    if (!step || !step.id) return null;
    const dismissed = new Set(
        Array.isArray(step.dismissed_suspect_keys) ? step.dismissed_suspect_keys : []
    );

    const llmReason = trimText(step.llm_suspect_reason || step.suspect_reason || "", 320);
    if (llmReason) {
        const signature = `llm:${llmReason.toLowerCase()}`;
        if (!dismissed.has(signature)) {
            return {
                source: "llm",
                code: "llm_suspect",
                signature,
                badge: "Possible extra step",
                reason: llmReason,
            };
        }
    }

    const heuristic = heuristicWarningsById?.[step.id] || null;
    if (heuristic && !dismissed.has(heuristic.signature)) {
        return heuristic;
    }

    return null;
}

/**
 * Return a map of step.id -> active warning (combining LLM + heuristics, respecting Keep).
 */
export function buildActiveSuspectWarnings(steps = []) {
    const list = Array.isArray(steps) ? steps : [];
    const heuristicMap = detectStepMistakes(list);
    const activeById = {};
    for (const step of list) {
        if (!step?.id) continue;
        const warning = getStepSuspectWarning(step, heuristicMap);
        if (warning) {
            activeById[step.id] = warning;
        }
    }
    return activeById;
}

/**
 * Build the sanitized request payload sent to the backend post-recording
 * LLM polish + mistake-review pass. Never includes raw input values.
 */
export function buildLlmReviewRequestPayload({ recordingId = null, title = "", module = "", steps = [] } = {}) {
    const cleanSteps = (Array.isArray(steps) ? steps : [])
        .filter((step) => step && step.id)
        .slice(0, 200)
        .map((step, index) => ({
            id: trimText(step.id, 128),
            index,
            instruction: trimText(step.instruction || "", 2000),
            target: {
                action: step.target?.action === "change" ? "change" : "click",
                model: trimText(step.target?.model || "", 240) || null,
                field: trimText(step.target?.field || "", 240) || null,
                target_key: trimText(step.target?.target_key || "", 240) || null,
            },
            breadcrumb: trimText(step.nav?.breadcrumb || "", 240) || null,
            app_name: trimText(step.nav?.appName || "", 120) || null,
        }));

    return {
        recording_id: trimText(recordingId || "", 128) || null,
        title: trimText(title || "", 240),
        module: trimText(module || "", 240),
        steps: cleanSteps,
    };
}

/**
 * Apply backend LLM review results ({ polished_instruction, suspect_reason })
 * to the current steps list without ever deleting steps.
 */
export function applyLlmReviewResults(steps = [], responsePayload = null) {
    const list = Array.isArray(steps) ? steps : [];
    const rawItems = Array.isArray(responsePayload)
        ? responsePayload
        : Array.isArray(responsePayload?.steps)
            ? responsePayload.steps
            : Array.isArray(responsePayload?.reviewed_steps)
                ? responsePayload.reviewed_steps
                : [];

    if (!rawItems.length) {
        return { steps: list.slice(), polishedCount: 0, flaggedCount: 0 };
    }

    const byId = new Map();
    const byIndex = new Map();
    rawItems.forEach((item, idx) => {
        if (!item || typeof item !== "object") return;
        const itemId = trimText(item.id || item.step_id || "", 128);
        if (itemId) byId.set(itemId, item);
        const itemIndex = Number.isInteger(item.index) ? item.index : idx;
        byIndex.set(itemIndex, item);
    });

    let polishedCount = 0;
    let flaggedCount = 0;

    const updatedSteps = list.map((step, idx) => {
        if (!step || typeof step !== "object") return step;
        const match = byId.get(step.id) || byIndex.get(idx);
        if (!match) return step;

        const nextStep = { ...step };
        const polished = trimText(match.polished_instruction || "", 2000);
        if (polished && polished !== trimText(step.instruction || "", 2000)) {
            nextStep.instruction = polished;
            polishedCount += 1;
        }

        const suspectReason = trimText(match.suspect_reason || "", 320);
        if (suspectReason) {
            nextStep.llm_suspect_reason = suspectReason;
            // If this is a fresh LLM reason not already explicitly dismissed, count it.
            const sig = `llm:${suspectReason.toLowerCase()}`;
            const dismissed = Array.isArray(nextStep.dismissed_suspect_keys)
                ? nextStep.dismissed_suspect_keys
                : [];
            if (!dismissed.includes(sig)) {
                flaggedCount += 1;
            }
        } else if (match.suspect_reason === null || match.suspect_reason === "") {
            delete nextStep.llm_suspect_reason;
        }

        return nextStep;
    });

    return {
        steps: updatedSteps,
        polishedCount,
        flaggedCount,
    };
}

/**
 * Mark a specific suspect warning as intentionally kept by the author.
 */
export function dismissStepSuspectWarning(steps = [], stepId = null, signature = null) {
    const list = Array.isArray(steps) ? steps : [];
    if (!stepId || !signature) return list.slice();
    return list.map((step) => {
        if (step?.id !== stepId) return step;
        const existing = Array.isArray(step.dismissed_suspect_keys)
            ? step.dismissed_suspect_keys
            : [];
        if (existing.includes(signature)) return step;
        return {
            ...step,
            dismissed_suspect_keys: [...existing, signature],
        };
    });
}
