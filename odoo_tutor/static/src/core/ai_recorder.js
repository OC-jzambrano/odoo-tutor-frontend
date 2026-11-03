/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { normalizeDomEvent } from "./normalize_event";

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

/** ✅ ESTA FUNCIÓN FALTABA / quedaba fuera de scope */
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

        let status = "idle"; // idle | recording | paused
        let sessionId = null;
        let exerciseId = null;

        const listeners = new Set();
        const logs = [];
        const lastSeen = new Map();

        let pickerActive = false;

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

          const ts = Date.now();
          const normalized = normalizeDomEvent({
            domEventType: "click",
            originalEvent: e,
            contextService,
          });


          // dedupe: type + (field/target_name/dom_key) + res_id + value?
          const keyPart =
            normalized.field ||
            normalized.meta?.target_name ||
            normalized.dom?.dom_key ||
            "unknown";
          const dedupeKey = `${normalized.type}|${keyPart}|${normalized.meta?.res_id ?? "null"}`;

          if (isDuplicate(dedupeKey, ts)) return;

          // payload “rico”
          const payload = {
            _id: uuid(),
            session_id: sessionId,
            exercise_id: exerciseId,
            timestamp: normalized.ts,
            normalized,
          };

          pushLog({
            ...payload,
            event_type: normalized.type,
            target: keyPart,
          });

          // payload “ticket style” (el de la imagen)
          const ticketPayload = {
            type: normalized.type,
            label: normalized.label,
            field: normalized.field,
            value: normalized.value,
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

          const keyPart = normalized.field || normalized.dom?.dom_key || "unknown";
          const val = normalized.value != null ? String(normalized.value) : "";
          const dedupeKey = `${normalized.type}|${keyPart}|${normalized.meta?.res_id ?? "null"}|${val}`;

          if (isDuplicate(dedupeKey, ts)) return;

          const payload = {
            _id: uuid(),
            session_id: sessionId,
            exercise_id: exerciseId,
            timestamp: normalized.ts,
            normalized,
          };

          pushLog({
            ...payload,
            event_type: normalized.type,
            target: keyPart,
            value_preview: cleanText(normalized.value),
          });

          const ticketPayload = {
            type: normalized.type,
            label: normalized.label,
            field: normalized.field,
            value: normalized.value,
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
            if (!sessionId || status === "idle") {
                sessionId = opts.sessionId || uuid();
            }
            exerciseId = opts.exerciseId || exerciseId || null;
            status = "recording";

            attachDomListeners();

            const payload = {
                _id: uuid(),
                session_id: sessionId,
                exercise_id: exerciseId,
                timestamp: nowIso(),
                status: "recording_started",
                context: getCtxSnapshot(),
            };
            pushLog({ ...payload, event_type: "SESSION", target: "-" });
            await sendWS("recording_started", payload).catch(() => {});
            return sessionId;
        }

        async function pauseRecording() {
            if (status !== "recording") return;
            status = "paused";
            detachDomListeners();

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
            lastSeen.clear();
        }

        // ✅ Picker robusto (sin dependencia rota)
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

        const api = {
            get status() { return status; },
            get sessionId() { return sessionId; },
            get exerciseId() { return exerciseId; },
            get logs() { return logs; },

            startRecording,
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
