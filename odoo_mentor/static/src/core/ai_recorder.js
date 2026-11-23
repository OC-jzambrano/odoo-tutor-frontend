/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { normalizeDomEvent } from "./normalize_event";
import {
    buildDraftStepFromEvent,
    buildStepNavSnapshot,
    clearPersistedRecordingSession,
    getRecorderStorageKey,
    isModuleEntryNavigationEvent,
    isRecorderUiElement,
    isSensitiveInputElement,
    loadPersistedRecordingSession,
    savePersistedRecordingSession,
} from "./recording_draft";

const DUP_WINDOW_MS = 800;
const MAX_LOCAL_LOGS = 250;

function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `rec_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function nowIso() {
    return new Date().toISOString();
}
function cleanText(s) {
    return (s || "").toString().trim().replace(/\s+/g, " ").slice(0, 120);
}
function safeCssEscape(x) {
    try { return CSS.escape(x); } catch { return x; }
}
function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
        let sel = node.nodeName.toLowerCase();
        if (node.id) {
            sel += "#" + node.id;
            parts.unshift(sel);
            break;
        }
        const cls = (node.className || "")
            .toString()
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join(".");
        if (cls) sel += "." + cls;

        let i = 1;
        let sib = node;
        while ((sib = sib.previousElementSibling)) {
            if (sib.nodeName === node.nodeName) i++;
        }
        sel += `:nth-of-type(${i})`;
        parts.unshift(sel);
        node = node.parentElement;
    }
    return parts.join(" > ");
}
function buildTargetKey(el) {
    if (!el) return "unknown";
    const tag = (el.tagName || "").toLowerCase();

    const name = el.getAttribute?.("name");
    if (name) return `${tag}.${name}`;

    const dataName = el.dataset?.name;
    if (dataName) return `${tag}.${dataName}`;

    const id = el.id;
    if (id) return `${tag}#${id}`;

    const cls = (el.className || "").toString().split(/\s+/).filter(Boolean);
    if (cls.length) return `${tag}.${cls[0]}`;

    return `${tag}`;
}
function buildSelector(el) {
    if (!el) return null;
    if (el.id) return `#${safeCssEscape(el.id)}`;

    if (el.dataset?.name) return `[data-name="${safeCssEscape(el.dataset.name)}"]`;

    const name = el.getAttribute?.("name");
    if (name) return `${(el.tagName || "").toLowerCase()}[name="${safeCssEscape(name)}"]`;

    const tag = (el.tagName || "").toLowerCase();
    const cls = (el.className || "").toString().split(/\s+/).filter(Boolean)[0];
    if (cls) return `${tag}.${safeCssEscape(cls)}`;

    return tag || null;
}
function describeTarget(el) {
    return {
        target_key: buildTargetKey(el),
        selector: buildSelector(el),
        css_selector: cssPath(el),
        tag: (el?.tagName || "").toLowerCase() || null,
        text: cleanText(el?.innerText || el?.textContent || ""),
        title: cleanText(el?.getAttribute?.("title") || ""),
        name: el?.getAttribute?.("name") || null,
        id: el?.id || null,
        className: (el?.className || "").toString().slice(0, 200),
    };
}

// Create the visual overlay and label for element picking.
function createPickerOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "o_ai_picker_overlay";
    overlay.style.position = "fixed";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483646";
    overlay.style.border = "2px solid rgba(59,130,246,.95)";
    overlay.style.borderRadius = "6px";
    overlay.style.background = "rgba(59,130,246,.10)";
    overlay.style.boxShadow = "0 8px 20px rgba(0,0,0,.25)";
    overlay.style.left = "-9999px";
    overlay.style.top = "-9999px";
    overlay.style.width = "0";
    overlay.style.height = "0";

    const label = document.createElement("div");
    label.className = "o_ai_picker_label";
    label.style.position = "fixed";
    label.style.zIndex = "2147483647";
    label.style.pointerEvents = "none";
    label.style.padding = "4px 8px";
    label.style.borderRadius = "8px";
    label.style.fontSize = "12px";
    label.style.fontWeight = "600";
    label.style.background = "rgba(17,24,39,.90)";
    label.style.color = "#fff";
    label.style.maxWidth = "60vw";
    label.style.whiteSpace = "nowrap";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.left = "-9999px";
    label.style.top = "-9999px";

    document.body.appendChild(overlay);
    document.body.appendChild(label);

    return {
        overlay,
        label,
        setRect(rect) {
            if (!rect) return;
            overlay.style.left = `${rect.left}px`;
            overlay.style.top = `${rect.top}px`;
            overlay.style.width = `${Math.max(0, rect.width)}px`;
            overlay.style.height = `${Math.max(0, rect.height)}px`;
        },
        setLabel(text, x, y) {
            label.textContent = text || "";
            label.style.left = `${Math.min(x + 12, window.innerWidth - 300)}px`;
            label.style.top = `${Math.min(y + 12, window.innerHeight - 40)}px`;
        },
        destroy() {
            overlay.remove();
            label.remove();
        },
    };
}

export const aiRecorderService = {
    start(env) {
        const aiWs = env.services.ai_ws;
        const contextService = env.services.context_service;
        const menuService = env.services.menu;
        const actionService = env.services.action;

        let status = "idle"; // idle | recording | paused
        let sessionId = null;
        let exerciseId = null;
        let recordingTitle = "";
        let recordingModule = null;
        let recordingModuleRootXmlid = null;
        let recordedSteps = [];
        let recordedFeed = [];
        let recordedStepIndex = 0;
        let recordedNote = "";
        let recordedDryRun = null;

        const listeners = new Set();
        const logs = [];
        const lastSeen = new Map();

        let pickerActive = false;

        function getStorage() {
            try {
                if (window.sessionStorage) return window.sessionStorage;
            } catch {}
            return null;
        }

        function getStorageKey() {
            const sess = (window.odoo && window.odoo.session_info) || {};
            return getRecorderStorageKey({ db: sess.db, uid: sess.uid });
        }

        function getSessionState() {
            const state = {
                status,
                sessionId,
                exerciseId,
                title: recordingTitle,
                module: recordingModule || "",
                moduleRootXmlid: recordingModuleRootXmlid,
                steps: recordedSteps.slice(),
                feed: recordedFeed.slice(),
                stepIndex: recordedStepIndex,
                note: recordedNote,
            };
            if (recordedDryRun?.active) {
                state.dryRun = { ...recordedDryRun };
            }
            return state;
        }

        function persistSessionState() {
            const storage = getStorage();
            const key = getStorageKey();
            if (status === "idle" || !sessionId) {
                clearPersistedRecordingSession(storage, key);
                return;
            }
            savePersistedRecordingSession(storage, key, getSessionState());
        }

        function syncSessionMeta(patch = {}) {
            if (!patch || typeof patch !== "object") return;
            if (patch.title !== undefined) recordingTitle = (patch.title || "").toString();
            if (patch.module !== undefined) recordingModule = patch.module || null;
            if (patch.moduleRootXmlid !== undefined) {
                recordingModuleRootXmlid = patch.moduleRootXmlid || null;
            }
            if (Array.isArray(patch.steps)) recordedSteps = patch.steps.slice();
            if (Array.isArray(patch.feed)) recordedFeed = patch.feed.slice(0, 60);
            if (patch.stepIndex !== undefined) {
                recordedStepIndex = Math.max(0, Math.floor(Number(patch.stepIndex) || 0));
            }
            if (patch.note !== undefined) recordedNote = (patch.note || "").toString();
            if (patch.dryRun !== undefined) {
                recordedDryRun =
                    patch.dryRun && patch.dryRun.active === true ? { ...patch.dryRun } : null;
            }
            persistSessionState();
        }

        function appendRecordedStep(step) {
            if (!step?.id) return;
            if (!recordedSteps.some((existing) => existing?.id === step.id)) {
                recordedSteps = [...recordedSteps, step];
                persistSessionState();
            }
        }

        function emitToUI(evt) {
            for (const fn of listeners) {
                try { fn(evt); } catch (e) { console.error("[ai_recorder] listener error", e); }
            }
        }

        function pushLog(evt) {
            logs.unshift(evt);
            if (logs.length > MAX_LOCAL_LOGS) logs.length = MAX_LOCAL_LOGS;
            emitToUI(evt);
        }

        function isDuplicate(dedupeKey, tsMs) {
            const last = lastSeen.get(dedupeKey) || 0;
            if (tsMs - last < DUP_WINDOW_MS) return true;
            lastSeen.set(dedupeKey, tsMs);
            return false;
        }

        function getCtxSnapshot() {
            try {
                return contextService?.getContext?.() || null;
            } catch {
                return null;
            }
        }

        function getBreadcrumbText() {
            try {
                const roots = Array.from(
                    document.querySelectorAll(
                        ".o_control_panel_breadcrumbs .o_breadcrumb, .o_navbar_breadcrumbs .o_breadcrumb, .o_fallback_breadcrumbs .o_breadcrumb"
                    )
                );
                const root = roots.find((el) => el?.getClientRects?.().length) || roots[0];
                if (!root) return "";
                const parts = Array.from(root.querySelectorAll(".breadcrumb .breadcrumb-item a"), (el) =>
                    cleanText(el.textContent)
                );
                const currentLabel = cleanText(root.querySelector(".o_last_breadcrumb_item")?.textContent);
                if (currentLabel) parts.push(currentLabel);
                return parts
                    .filter((part, index, allParts) => part && part !== "..." && allParts[index - 1] !== part)
                    .join(" / ");
            } catch {
                return "";
            }
        }

        function getNavSnapshot(el) {
            return buildStepNavSnapshot({
                menuService,
                actionService,
                contextService,
                el,
                breadcrumb: getBreadcrumbText(),
            });
        }

        async function sendWS(event_name, event_data) {
            await aiWs.ensureConnected?.().catch(() => null);
            return aiWs.sendEvent({
                type: "recorder_event",
                event_name,
                event_data,
            });
        }

        function classifyEvent(evType, targetEl) {
            let event_type = evType;
            const cls = (targetEl?.className || "").toString();
            if (evType === "click" && /\bo_form_button_save\b/.test(cls)) event_type = "update";
            if (evType === "click" && /\bo_list_button_add\b/.test(cls)) event_type = "create";
            return event_type;
        }

        function onDomClick(e) {
          if (status !== "recording" || pickerActive) return;
          if (isRecorderUiElement(e?.target) || isSensitiveInputElement(e?.target)) return;

          const ts = Date.now();
          const normalized = normalizeDomEvent({
            domEventType: "click",
            originalEvent: e,
            contextService,
          });
          if (isSensitiveInputElement(e?.target, normalized)) return;
          if (
            isModuleEntryNavigationEvent(normalized, {
              module: recordingModule,
              moduleRootXmlid: recordingModuleRootXmlid,
              el: e?.target,
            })
          ) {
            return;
          }

          // dedupe: type + (field/target_name/dom_key) + res_id + value?
          const keyPart =
            normalized.field ||
            normalized.meta?.target_name ||
            normalized.dom?.dom_key ||
            "unknown";
          const dedupeKey = `${normalized.type}|${keyPart}|${normalized.meta?.res_id ?? "null"}`;

          if (isDuplicate(dedupeKey, ts)) return;

          const generatedStep = buildDraftStepFromEvent(normalized, {
            id: uuid(),
            el: e?.target,
            module: recordingModule,
            moduleRootXmlid: recordingModuleRootXmlid,
            nav: getNavSnapshot(e?.target),
            selector: buildSelector(e?.target),
          });
          if (generatedStep) {
            appendRecordedStep(generatedStep);
            pushLog({
              _id: generatedStep.id,
              session_id: sessionId,
              exercise_id: exerciseId,
              timestamp: normalized.ts,
              event_type: "STEP_GENERATED",
              target: generatedStep.target?.target_key || keyPart,
              step: generatedStep,
            });
          }

          // payload “ticket style” (el de la imagen) - exclude raw input values
          const ticketPayload = {
            type: normalized.type,
            label: normalized.label,
            field: normalized.field,
            value: null,
            meta: normalized.meta,
            quality: normalized.quality,
            ts: normalized.ts,
            v: normalized.v,
          };

          sendWS("normalized_event", ticketPayload).catch((err) => {
            pushLog({
              _id: uuid(),
              session_id: sessionId,
              exercise_id: exerciseId,
              timestamp: nowIso(),
              event_type: "WS_ERROR",
              target: keyPart,
              error: err?.message || String(err),
            });
          });
        }

        function onDomChange(e) {
          if (status !== "recording" || pickerActive) return;

          const el = e.target;
          if (!el) return;
          if (isRecorderUiElement(el) || isSensitiveInputElement(el)) return;
          if (el.type === "checkbox") {
            return;
          }

          const tag = (el.tagName || "").toUpperCase();
          if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

          const ts = Date.now();
          const normalized = normalizeDomEvent({
            domEventType: "change",
            originalEvent: e,
            contextService,
          });
          if (isSensitiveInputElement(el, normalized)) return;

          const keyPart = normalized.field || normalized.dom?.dom_key || "unknown";
          const dedupeKey = `${normalized.type}|${keyPart}|${normalized.meta?.res_id ?? "null"}`;

          if (isDuplicate(dedupeKey, ts)) return;

          const generatedStep = buildDraftStepFromEvent(normalized, {
            id: uuid(),
            el,
            module: recordingModule,
            moduleRootXmlid: recordingModuleRootXmlid,
            nav: getNavSnapshot(el),
            selector: buildSelector(el),
          });
          if (generatedStep) {
            appendRecordedStep(generatedStep);
            pushLog({
              _id: generatedStep.id,
              session_id: sessionId,
              exercise_id: exerciseId,
              timestamp: normalized.ts,
              event_type: "STEP_GENERATED",
              target: generatedStep.target?.target_key || keyPart,
              step: generatedStep,
            });
          }

          const ticketPayload = {
            type: normalized.type,
            label: normalized.label,
            field: normalized.field,
            value: null,
            meta: normalized.meta,
            quality: normalized.quality,
            ts: normalized.ts,
            v: normalized.v,
          };

          sendWS("normalized_event", ticketPayload).catch(() => {});
        }

        function attachDomListeners() {
            document.addEventListener("click", onDomClick, true);
            document.addEventListener("change", onDomChange, true);
        }
        function detachDomListeners() {
            document.removeEventListener("click", onDomClick, true);
            document.removeEventListener("change", onDomChange, true);
        }

        async function startRecording(opts = {}) {
            const resuming = status === "paused" && !!sessionId;
            if (!sessionId || status === "idle") {
                sessionId = opts.sessionId || uuid();
                recordedSteps = [];
                recordedFeed = [];
                recordedStepIndex = 0;
                recordedNote = "";
                recordedDryRun = null;
            }
            exerciseId = opts.exerciseId || exerciseId || null;
            if (opts.title !== undefined) {
                recordingTitle = (opts.title || "").toString();
            }
            if (opts.module !== undefined) {
                recordingModule = opts.module || null;
            }
            if (opts.moduleRootXmlid !== undefined) {
                recordingModuleRootXmlid = opts.moduleRootXmlid || null;
            }
            status = "recording";

            attachDomListeners();
            persistSessionState();

            const eventName = resuming ? "recording_resumed" : "recording_started";
            const payload = {
                _id: uuid(),
                session_id: sessionId,
                exercise_id: exerciseId,
                timestamp: nowIso(),
                status: eventName,
                context: getCtxSnapshot(),
            };
            pushLog({ ...payload, event_type: "SESSION", target: "-" });
            await sendWS(eventName, payload).catch(() => {});
            return sessionId;
        }

        async function resumeRecording() {
            if (status !== "paused") return sessionId;
            return startRecording();
        }

        async function pauseRecording() {
            if (status !== "recording") return;
            status = "paused";
            detachDomListeners();
            persistSessionState();

            const payload = {
                _id: uuid(),
                session_id: sessionId,
                exercise_id: exerciseId,
                timestamp: nowIso(),
                status: "recording_paused",
            };
            pushLog({ ...payload, event_type: "SESSION", target: "-" });
            await sendWS("recording_paused", payload).catch(() => {});
        }

        async function finishRecording() {
            detachDomListeners();
            status = "idle";

            const payload = {
                _id: uuid(),
                session_id: sessionId,
                exercise_id: exerciseId,
                timestamp: nowIso(),
                status: "recording_finished",
            };
            pushLog({ ...payload, event_type: "SESSION", target: "-" });
            await sendWS("recording_finished", payload).catch(() => {});

            sessionId = null;
            exerciseId = null;
            recordingTitle = "";
            recordingModule = null;
            recordingModuleRootXmlid = null;
            recordedSteps = [];
            recordedFeed = [];
            recordedStepIndex = 0;
            recordedNote = "";
            recordedDryRun = null;
            lastSeen.clear();
            clearPersistedRecordingSession(getStorage(), getStorageKey());
        }

        // Let the user interactively pick a DOM target element.
        async function pickTarget({ timeoutMs = 30000 } = {}) {
            if (pickerActive) return null;
            pickerActive = true;

            const { overlay, label, destroy } = createPickerOverlay();
            document.body.style.cursor = "crosshair";

            let resolved = false;
            let timeoutId = null;

            const safeResolve = (val) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolvePromise(val);
            };

            let resolvePromise;
            const p = new Promise((resolve) => {
                resolvePromise = resolve;
            });

            const move = (ev) => {
                const el = document.elementFromPoint(ev.clientX, ev.clientY);
                if (!el) return;
                const r = el.getBoundingClientRect();

                overlay.style.left = `${Math.max(0, r.left)}px`;
                overlay.style.top = `${Math.max(0, r.top)}px`;
                overlay.style.width = `${Math.max(0, r.width)}px`;
                overlay.style.height = `${Math.max(0, r.height)}px`;

                const d = describeTarget(el);
                label.textContent = `${d.target_key} ${d.selector || ""}`.trim();
                label.style.left = `${Math.min(window.innerWidth - 240, ev.clientX + 12)}px`;
                label.style.top = `${Math.min(window.innerHeight - 28, ev.clientY + 12)}px`;
            };

            const stop = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
            };

            const onMouseUpPick = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                try {
                    const el = document.elementFromPoint(ev.clientX, ev.clientY);
                    const picked = describeTarget(el);
                    safeResolve(picked || null);
                } catch (err) {
                    console.warn("[ai_recorder] pickTarget onMouseUp error:", err);
                    safeResolve(null);
                }
            };

            const onKey = (ev) => {
                if (ev.key === "Escape") {
                    ev.preventDefault();
                    ev.stopPropagation();
                    safeResolve(null);
                }
            };

            const cleanup = () => {
                pickerActive = false;
                if (timeoutId) clearTimeout(timeoutId);

                document.body.style.cursor = "";
                document.removeEventListener("mousemove", move, true);
                document.removeEventListener("mousedown", stop, true);
                document.removeEventListener("click", stop, true);
                document.removeEventListener("mouseup", onMouseUpPick, true);
                document.removeEventListener("keydown", onKey, true);

                destroy();
            };

            // listeners captura global
            document.addEventListener("mousemove", move, true);
            document.addEventListener("mousedown", stop, true);
            document.addEventListener("click", stop, true);
            document.addEventListener("mouseup", onMouseUpPick, true);
            document.addEventListener("keydown", onKey, true);

            timeoutId = setTimeout(() => safeResolve(null), timeoutMs);

            return p;
        }

        async function sendStep({ instruction = "", target = null, metadata = null } = {}) {
            const payload = {
                _id: uuid(),
                session_id: sessionId,
                exercise_id: exerciseId,
                timestamp: nowIso(),
                event_type: "STEP_SAVED",
                instruction: (instruction || "").toString(),
                target: target?.target_key || null,
                target_meta: target || null,
                metadata: metadata || null,
                context: getCtxSnapshot(),
            };

            pushLog({ ...payload, target: payload.target || "-" });
            await sendWS("record_step", payload).catch(() => {});
            return payload;
        }

        const restored = loadPersistedRecordingSession(getStorage(), getStorageKey());
        if (restored) {
            status = restored.status;
            sessionId = restored.sessionId;
            exerciseId = restored.exerciseId;
            recordingTitle = restored.title;
            recordingModule = restored.module || null;
            recordingModuleRootXmlid = restored.moduleRootXmlid;
            recordedSteps = restored.steps;
            recordedFeed = restored.feed;
            recordedStepIndex = restored.stepIndex;
            recordedNote = restored.note;
            recordedDryRun = restored.dryRun ? { ...restored.dryRun } : null;
            if (status === "recording") {
                attachDomListeners();
            }
        }

        const api = {
            get status() { return status; },
            get sessionId() { return sessionId; },
            get exerciseId() { return exerciseId; },
            get logs() { return logs; },

            getSessionState,
            syncSessionMeta,

            startRecording,
            resumeRecording,
            pauseRecording,
            finishRecording,
            pickTarget,
            sendStep,

            subscribe: (fn) => listeners.add(fn),
            unsubscribe: (fn) => listeners.delete(fn),
        };

        window.aiRecorder = api;
        return api;
    },
};

registry.category("services").add("ai_recorder", aiRecorderService);
