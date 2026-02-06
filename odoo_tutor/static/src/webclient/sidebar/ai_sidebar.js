/* eslint-disable */
/** @odoo-module **/
import {
    Component,
    onMounted,
    onWillUnmount,
    useEffect,
    useRef,
    useState,
} from "@odoo/owl";

import { registry } from "@web/core/registry";
import { cookie } from "@web/core/browser/cookie";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { imageUrl } from "@web/core/utils/urls";
import { useMouseListeners } from "../../core/utils";
import { rpc } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";

export class AiSidebar extends Component {
    static template = "ai_chat.AiSidebar";
    static props = {};

    setup() {
        super.setup();
        this.contextService = useService("context_service");

        this.notification = useService("notification");

        this._activeFeedbackPopover = null;
        this._feedbackObserver = null;

        this.modelPlaceholders = {
            "sale.order": "You're creating a Quotation, want help?",
            "account.move": "Need help with this Invoice?",
            "project.task": "What do you need to know about this Task?",
            default: "How can I help you today?",
        };

        this.contextInterval = setInterval(() => {
            this.state.currentContext = this.contextService.getContext();
        }, 500);

        this.containerRef = useRef("container");
        this.chatUiRef = useRef("chat-ui");
        this.handleRef = useRef("handle");
        this.aiWs = useService("ai_ws");
        this.aiRecorder = useService("ai_recorder");


        this.state = useState({
            width: "600px",
            isResizing: false,
            isStreamingMode: false,
            isLoading: false,
            currentContext: null,
            placeholder: this.modelPlaceholders.default,
            composerHeight: 0,
            composerWidth: 0,
            isChatInitialized: false,
            processActive: false,
            timerValue: "00:00:00",
            timerInterval: null,
            timerSeconds: 0,
            showButtons: false,
            showResultModal: false,
            exerciseId: null,
            firstFailedStep: null,
            finishLoading: false,
            result: "failed",
            recorderStatus: "idle",        // idle | recording | paused
            recorderSessionId: null,
            recorderFeed: [],
            recorderStepIndex: 0,
            recorderNote: "",
            recorderPicked: null,
            recorderPicking: false,
            activePanel: "chat",
            wsStatus: "unknown",
            showRecorderPanel: false,          // false = chat, true = recorder
            canSeeRecorderToggle: false,
            isPickingElement: false,
        });

        this._savedStepHashes = new Set();

        useEffect(
            (currentContext) => {
                if (!currentContext) return;

                const model = currentContext.model;
                const newPlaceholder =
                    this.modelPlaceholders[model] || this.modelPlaceholders.default;

                if (!this.state.isChatInitialized) {
                    this.state.placeholder = newPlaceholder;
                    this.createAiChat();
                    this.state.isChatInitialized = true;
                } else if (this.state.placeholder !== newPlaceholder) {
                    this.state.placeholder = newPlaceholder;
                    this.updateChatPlaceholder(newPlaceholder);
                }
            },
            () => [this.state.currentContext]
        );

        onMounted(() => {
            const el = this._getOffcanvasEl();
            if (!el) return;

            this._onHiddenOffcanvas = () => this._forceUiUnlock();
            el.addEventListener("hidden.bs.offcanvas", this._onHiddenOffcanvas);

            this._forceUiUnlock();

            this._loadRecorderPermission();

            this.contextInterval = setInterval(() => {
                const newContext = this.contextService.getContext();
                if (
                    newContext &&
                    (!this.state.currentContext ||
                        JSON.stringify(newContext) !==
                            JSON.stringify(this.state.currentContext))
                ) {
                    this.state.currentContext = newContext;
                }
            }, 200);

            this.observer = new MutationObserver(() => {
                const composer = this.chatUiRef.el.querySelector(".nlux-composer-container");
                if (composer) {
                    this.state.composerWidth = composer.offsetWidth;
                    this.state.composerHeight = composer.offsetHeight;
                }
            });
            this.observer.observe(this.chatUiRef.el, { childList: true, subtree: true });

            this._recListener = (ev) => {
                this.state.recorderFeed = [ev, ...(this.state.recorderFeed || [])].slice(0, 60);
                this.state.wsStatus = this.aiWs?.connected ? "online" : "offline";
            };
            this.aiRecorder.subscribe(this._recListener);
            this.state.wsStatus = this.aiWs?.connected ? "online" : "offline";
        });

        const aiBotStreamListener = ({ message, stop }) => {
            if (stop && this.onStop) this.onStop();
            else if (!stop && this.onMessage) this.onMessage(message);
        };
        this.busService = this.env.services.bus_service;
        this.busService.subscribe("ai_bot_stream", aiBotStreamListener);

        onWillUnmount(() => {
            const el = this._getOffcanvasEl();
            if (el && this._onHiddenOffcanvas) {
                el.removeEventListener("hidden.bs.offcanvas", this._onHiddenOffcanvas);
            }
            this._forceUiUnlock();

            clearInterval(this.contextInterval);
            this.busService.unsubscribe("ai_bot_stream", aiBotStreamListener);
            if (this.state.timerInterval) clearInterval(this.state.timerInterval);
            this._teardownAntiAutoScroll();
            this._disconnectContainerFinder();
            this._teardownFeedbackObserver();
            this._restoreSidebarAfterPick?.();
            document.body.classList.remove("o_ai_pick_mode");
            this._exitPickModeUI?.();
            if (this._recListener) {
                this.aiRecorder.unsubscribe(this._recListener);
                this._recListener = null;
            }
        });

        this.onHandleMouseDown = useMouseListeners({
            onMouseDown: this.onMouseDown,
            onMouseMove: this.onMouseMove,
            onMouseUp: this.onMouseUp,
        });
    }

    _getOffcanvasEl() {
        return this.containerRef?.el || document.getElementById("offcanvasAiSidebar");
    }

    _getBsOffcanvas(el) {
        const Offcanvas = window.bootstrap?.Offcanvas;
        if (!Offcanvas || !el) return null;
        return Offcanvas.getOrCreateInstance(el, {
            backdrop: true,   // permite cerrar al click fuera
            keyboard: true,   // ESC cierra
            scroll: false,
        });
    }

    _waitEvent(el, evtName, timeout = 900) {
        return new Promise((resolve) => {
            let done = false;
            const onEvt = () => {
                if (done) return;
                done = true;
                clearTimeout(t);
                el.removeEventListener(evtName, onEvt);
                resolve(true);
            };
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                el.removeEventListener(evtName, onEvt);
                resolve(false);
            }, timeout);
            el.addEventListener(evtName, onEvt, { once: true });
        });
    }

    _forceUiUnlock() {
        // limpia cualquier backdrop huérfano
        document.querySelectorAll(".offcanvas-backdrop").forEach((b) => b.remove());

        // limpia locks del body
        document.body.classList.remove("offcanvas-open", "modal-open");
        document.body.style.removeProperty("overflow");
        document.body.style.removeProperty("padding-right");

        // limpia clases/estilos raros del sidebar si quedaron de pruebas previas
        const el = this._getOffcanvasEl();
        if (el) {
            el.classList.remove("hiding", "showing");
            el.style.removeProperty("visibility");
            el.style.removeProperty("pointer-events");
            el.style.removeProperty("display");
        }
    }

    async hideSidebar() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        const bs = this._getBsOffcanvas(el);
        if (bs) {
            const p = this._waitEvent(el, "hidden.bs.offcanvas", 900);
            bs.hide();
            await p;
        } else {
            // fallback mínimo
            el.classList.remove("show");
        }
        this._forceUiUnlock();
    }

    async showSidebar() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        this._forceUiUnlock(); // por si había basura previa
        const bs = this._getBsOffcanvas(el);

        if (bs) {
            const p = this._waitEvent(el, "shown.bs.offcanvas", 900);
            bs.show();
            await p;
        } else {
            el.classList.add("show");
        }
    }

    async onCloseSidebar() {
        await this.hideSidebar();
    }

    // Pick element: cerrar -> pick -> reabrir
    async onRecorderPick() {
        if (this.state.recorderStatus === "idle") return;

        // opcional: si tienes modo chat/recorder
        // this.state.sidebarMode = "recorder";

        await this.hideSidebar();

        try {
            const picked = await this.aiRecorder.pickTarget({ timeoutMs: 30000 });
            if (picked) {
                this.state.recorderPicked = picked;
            }
        } catch (e) {
            console.warn("[ai_recorder] pick failed:", e);
        } finally {
            await this.showSidebar();
            // this.state.sidebarMode = "recorder";
        }
    }

    _waitBsEvent(el, eventName, timeout = 700) {
        return new Promise((resolve) => {
            let done = false;
            const onEvt = () => {
                if (done) return;
                done = true;
                clearTimeout(t);
                el.removeEventListener(eventName, onEvt);
                resolve(true);
            };
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                el.removeEventListener(eventName, onEvt);
                resolve(false);
            }, timeout);
            el.addEventListener(eventName, onEvt, { once: true });
        });
    }

    _cleanupOffcanvasArtifacts() {
        // quita backdrops huérfanos
        document.querySelectorAll(".offcanvas-backdrop").forEach((b) => b.remove());

        // limpia lock del body que deja opaca/bloqueada la vista
        document.body.classList.remove("modal-open", "offcanvas-open");
        document.body.style.removeProperty("overflow");
        document.body.style.removeProperty("padding-right");
    }

    async _closeSidebarForPick() {
        const el = this._getOffcanvasEl();
        if (!el) return false;

        const wasOpen = el.classList.contains("show");
        if (!wasOpen) {
            this._cleanupOffcanvasArtifacts();
            return false;
        }

        let closedByBs = false;
        const inst = this._getOffcanvasInstance(el);
        if (inst) {
            try {
                const waitHidden = this._waitBsEvent(el, "hidden.bs.offcanvas", 800);
                inst.hide();
                closedByBs = await waitHidden;
            } catch (_) {}
        }

        // fallback si bootstrap no disparó hidden
        if (!closedByBs) {
            el.classList.remove("show", "showing");
            el.classList.add("hiding");
            el.setAttribute("aria-hidden", "true");
            el.removeAttribute("aria-modal");
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
        }

        this._cleanupOffcanvasArtifacts();
        return true;
    }

    async _reopenSidebarAfterPick(shouldOpen) {
        if (!shouldOpen) return;

        const el = this._getOffcanvasEl();
        if (!el) return;

        // revierte fallback visual por si se usó
        el.classList.remove("hiding");
        el.style.removeProperty("visibility");
        el.style.removeProperty("pointer-events");

        const inst = this._getOffcanvasInstance(el);
        if (inst) {
            try {
                const waitShown = this._waitBsEvent(el, "shown.bs.offcanvas", 800);
                inst.show();
                await waitShown;
                return;
            } catch (_) {}
        }

        // fallback final (si bootstrap no está disponible)
        el.classList.add("show");
        el.removeAttribute("aria-hidden");
        el.setAttribute("aria-modal", "true");
        document.body.style.overflow = "hidden";
        if (!document.querySelector(".offcanvas-backdrop.show")) {
            const bd = document.createElement("div");
            bd.className = "offcanvas-backdrop fade show";
            document.body.appendChild(bd);
        }
    }

    _getBackdropEls() {
        return Array.from(document.querySelectorAll(".offcanvas-backdrop"));
    }

    _waitEventOnce(el, eventName, timeout = 700) {
        return new Promise((resolve) => {
            if (!el) return resolve(false);
            let done = false;
            const onEvt = () => {
                if (done) return;
                done = true;
                el.removeEventListener(eventName, onEvt);
                resolve(true);
            };
            el.addEventListener(eventName, onEvt, { once: true });
            setTimeout(() => {
                if (done) return;
                done = true;
                el.removeEventListener(eventName, onEvt);
                resolve(false);
            }, timeout);
        });
    }

    _manualHideOffcanvas(offcanvasEl) {
        if (!offcanvasEl) return;

        // guardar estilos previos
        offcanvasEl.dataset._aiPrevStyle = offcanvasEl.getAttribute("style") || "";

        offcanvasEl.classList.remove("show");
        offcanvasEl.setAttribute("aria-hidden", "true");

        // forzar fuera de pantalla + no interacción
        offcanvasEl.style.setProperty("visibility", "hidden", "important");
        offcanvasEl.style.setProperty("pointer-events", "none", "important");
        offcanvasEl.style.setProperty("transform", "translateX(110%)", "important");

        // ocultar backdrops activos
        this._getBackdropEls().forEach((bd, i) => {
            bd.dataset._aiIdx = String(i);
            bd.dataset._aiPrevStyle = bd.getAttribute("style") || "";
            bd.classList.remove("show");
            bd.style.setProperty("opacity", "0", "important");
            bd.style.setProperty("pointer-events", "none", "important");
        });

        // limpiar lock de body que deja Bootstrap
        this._aiBodyPrevOverflow = document.body.style.overflow || "";
        this._aiBodyPrevPaddingRight = document.body.style.paddingRight || "";
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
    }

    _manualRestoreOffcanvas(offcanvasEl) {
        if (!offcanvasEl) return;

        // restaurar style previo del offcanvas
        const prev = offcanvasEl.dataset._aiPrevStyle;
        if (prev !== undefined) {
            offcanvasEl.setAttribute("style", prev);
            delete offcanvasEl.dataset._aiPrevStyle;
        } else {
            offcanvasEl.style.removeProperty("visibility");
            offcanvasEl.style.removeProperty("pointer-events");
            offcanvasEl.style.removeProperty("transform");
        }

        // backdrops
        this._getBackdropEls().forEach((bd) => {
            const prevBd = bd.dataset._aiPrevStyle;
            if (prevBd !== undefined) {
                bd.setAttribute("style", prevBd);
                delete bd.dataset._aiPrevStyle;
                delete bd.dataset._aiIdx;
            } else {
                bd.style.removeProperty("opacity");
                bd.style.removeProperty("pointer-events");
            }
        });

        // body
        document.body.style.overflow = this._aiBodyPrevOverflow || "";
        document.body.style.paddingRight = this._aiBodyPrevPaddingRight || "";
    }

    async _hideSidebarForPick() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        // intenta vía Bootstrap primero
        const BS = window.bootstrap;
        if (BS?.Offcanvas) {
            try {
                const inst = BS.Offcanvas.getOrCreateInstance(el);
                inst.hide();
                const hidden = await this._waitEventOnce(el, "hidden.bs.offcanvas", 700);
                if (hidden) return;
            } catch (e) {
                // cae a manual
            }
        }

        // fallback robusto
        this._manualHideOffcanvas(el);
    }

    async _showSidebarAfterPick() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        const BS = window.bootstrap;
        if (BS?.Offcanvas) {
            try {
                const inst = BS.Offcanvas.getOrCreateInstance(el);
                inst.show();
                await this._waitEventOnce(el, "shown.bs.offcanvas", 700);
                return;
            } catch (e) {
                // cae a manual
            }
        }

        // fallback manual
        this._manualRestoreOffcanvas(el);
        el.classList.add("show");
        el.style.setProperty("visibility", "visible");
        el.style.setProperty("pointer-events", "auto");
        el.style.setProperty("transform", "none");
    }

    _enterPickModeUI() {
        // Guardar estado previo del body por si Odoo/Bootstrap lo tocó
        this._pickPrevBodyOverflow = document.body.style.overflow || "";
        this._pickPrevBodyPaddingRight = document.body.style.paddingRight || "";

        // Clase global para ocultar panel/backdrop
        document.body.classList.add("o_ai_pick_mode");

        // Desbloquea interacción de la vista detrás
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
    }

    _exitPickModeUI() {
        document.body.classList.remove("o_ai_pick_mode");

        // Restaurar estilos previos
        document.body.style.overflow = this._pickPrevBodyOverflow || "";
        document.body.style.paddingRight = this._pickPrevBodyPaddingRight || "";
    }

    _hideSidebarForPick() {
        const panel = this.containerRef?.el;
        this._pickUiStash = { panel: null, panelStyle: null, backdrops: [] };

        if (panel) {
            this._pickUiStash.panel = panel;
            this._pickUiStash.panelStyle = {
                visibility: panel.style.visibility,
                opacity: panel.style.opacity,
                pointerEvents: panel.style.pointerEvents,
            };
            panel.style.visibility = "hidden";
            panel.style.opacity = "0";
            panel.style.pointerEvents = "none";
        }

        const backdrops = document.querySelectorAll(".offcanvas-backdrop");
        backdrops.forEach((bd) => {
            this._pickUiStash.backdrops.push({
                el: bd,
                display: bd.style.display,
                visibility: bd.style.visibility,
                opacity: bd.style.opacity,
                pointerEvents: bd.style.pointerEvents,
            });
            bd.style.display = "none";
            bd.style.visibility = "hidden";
            bd.style.opacity = "0";
            bd.style.pointerEvents = "none";
        });

        document.body.classList.add("o_ai_pick_mode");
    }

    _restoreSidebarAfterPick() {
        const st = this._pickUiStash;
        if (!st) return;

        if (st.panel) {
            st.panel.style.visibility = st.panelStyle?.visibility || "";
            st.panel.style.opacity = st.panelStyle?.opacity || "";
            st.panel.style.pointerEvents = st.panelStyle?.pointerEvents || "";
        }

        (st.backdrops || []).forEach((x) => {
            x.el.style.display = x.display || "";
            x.el.style.visibility = x.visibility || "";
            x.el.style.opacity = x.opacity || "";
            x.el.style.pointerEvents = x.pointerEvents || "";
        });

        document.body.classList.remove("o_ai_pick_mode");
        this._pickUiStash = null;
    }

    _getOffcanvasEl() {
        return this.containerRef?.el || document.getElementById("offcanvasAiSidebar");
    }

    _getBootstrapOffcanvasClass() {
        // compat robusta
        if (window.bootstrap?.Offcanvas) return window.bootstrap.Offcanvas;
        try {
            // por si bootstrap está global sin window.bootstrap
            return bootstrap?.Offcanvas;
        } catch {
            return null;
        }
    }

    _waitEventOrTimeout(el, eventName, timeoutMs = 500) {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                el?.removeEventListener?.(eventName, onEvent, true);
                resolve();
            };
            const onEvent = () => finish();
            el?.addEventListener?.(eventName, onEvent, { once: true, capture: true });
            setTimeout(finish, timeoutMs);
        });
    }

    async _hideSidebarForPicking() {
        const el = this._getOffcanvasEl();
        const inst = this._getOffcanvasInstance();
        if (!el || !inst) return;

        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                el.removeEventListener("hidden.bs.offcanvas", onHidden);
                resolve();
            };
            const onHidden = () => finish();

            el.addEventListener("hidden.bs.offcanvas", onHidden, { once: true });
            inst.hide();

            // fallback por si no dispara evento
            setTimeout(finish, 300);
        });
    }

    async _showSidebarBackToRecorder() {
        const inst = this._getOffcanvasInstance();
        if (!inst) return;

        // aseguras volver a la vista recorder
        this.state.activePanel = "recorder"; // usa aquí tu clave real de toggle

        // pequeño wait para evitar glitches visuales
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        inst.show();
    }

    async _hideOffcanvasForPick() {
        const panel = this.containerRef?.el;
        if (!panel) return null;

        const stash = {
            panel,
            reopen: panel.classList.contains("show"),
            bs: null,
            hiddenBackdrops: [],
        };

        try {
            stash.bs = window.bootstrap?.Offcanvas?.getOrCreateInstance(panel) || null;
        } catch (_) {
            stash.bs = null;
        }

        // 1) Cerrar offcanvas real (crea/gestiona backdrop correctamente)
        if (stash.reopen && stash.bs?.hide) {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    panel.removeEventListener("hidden.bs.offcanvas", onHidden);
                    resolve();
                };
                const onHidden = () => finish();
                panel.addEventListener("hidden.bs.offcanvas", onHidden, { once: true });
                stash.bs.hide();
                setTimeout(finish, 350); // fallback
            });
        } else {
            // fallback duro
            panel.classList.remove("show");
            panel.style.setProperty("visibility", "hidden", "important");
            panel.style.setProperty("pointer-events", "none", "important");
            panel.style.setProperty("transform", "translateX(100%)", "important");
        }

        // 2) Forzar ocultar cualquier backdrop residual
        const bds = document.querySelectorAll(".offcanvas-backdrop, .modal-backdrop");
        bds.forEach((bd) => {
            stash.hiddenBackdrops.push({
                el: bd,
                style: bd.getAttribute("style"),
                className: bd.className,
            });
            bd.classList.remove("show");
            bd.style.setProperty("display", "none", "important");
            bd.style.setProperty("opacity", "0", "important");
            bd.style.setProperty("pointer-events", "none", "important");
            bd.style.setProperty("visibility", "hidden", "important");
        });

        document.body.classList.remove("modal-open");
        document.body.classList.add("o_ai_pick_mode");

        return stash;
    }

    async _restoreOffcanvasAfterPick(stash) {
        if (!stash) return;

        document.body.classList.remove("o_ai_pick_mode");

        // restaurar backdrop (si seguía abierto antes)
        (stash.hiddenBackdrops || []).forEach(({ el, style }) => {
            if (!el) return;
            if (style == null) el.removeAttribute("style");
            else el.setAttribute("style", style);
        });

        if (stash.reopen && stash.bs?.show) {
            stash.bs.show();
            await new Promise((r) => setTimeout(r, 50));
        } else if (stash.panel) {
            stash.panel.style.removeProperty("visibility");
            stash.panel.style.removeProperty("pointer-events");
            stash.panel.style.removeProperty("transform");
        }
    }

    _pushSavedStepToFeed(stepPayload) {
        const item = {
            _id: stepPayload.step_id,
            event_type: "STEP_SAVED",
            target: stepPayload.target || "(instruction only)",
            timestamp: stepPayload.timestamp,
            note: stepPayload.instruction || "",
        };
        this.state.recorderFeed.unshift(item);
        if (this.state.recorderFeed.length > 100) {
            this.state.recorderFeed.pop();
        }
    }

    async _loadRecorderPermission() {
        try {
            this.state.canSeeRecorderToggle = await user.hasGroup("base.group_system");
        } catch (e) {
            console.warn("[ai_sidebar] hasGroup failed:", e);
            this.state.canSeeRecorderToggle = false;
        }
    }

    // ✅ NEW: cambiar vista chat/recorder
    toggleRecorderPanel() {
        if (!this.state.canSeeRecorderToggle) return;

        this.state.showRecorderPanel = !this.state.showRecorderPanel;

        // limpiar popovers abiertos al cambiar de modo
        this._closeFeedbackPopover();

        if (this.state.showRecorderPanel) {
            this._setComposerAutoFocus(false);
            this.aiRecorder?.setPanelVisible?.(true);
        } else {
            this._setComposerAutoFocus(true);
            this.aiRecorder?.setPanelVisible?.(false);
        }
    }

    async onRecorderStart() {
        const sid = await this.aiRecorder.startRecording({
            exerciseId: this.state.exerciseId || null,
        });
        this.state.recorderSessionId = sid;
        this.state.recorderStatus = "recording";
        this.state.wsStatus = this.aiWs?.connected ? "online" : "offline";
    }

    async onRecorderPause() {
        await this.aiRecorder.pauseRecording();
        this.state.recorderStatus = "paused";
    }

    async onRecorderFinish() {
        await this.aiRecorder.finishRecording();
        this.state.recorderStatus = "idle";
        this.state.recorderSessionId = null;
        this.state.recorderPicked = null;
        this.state.recorderNote = "";
    }


    onRecorderClearPick() {
        this.state.recorderPicked = null;
    }

    async onRecorderSaveStep() {
        if (this.state.recorderStatus === "idle") return;

        const instruction = (this.state.recorderNote || "").trim();
        const picked = this.state.recorderPicked || null;

        // Permite step con solo texto o solo elemento
        if (!instruction && !picked) {
            this.notification.add(_t("Add an instruction or pick an element first."), { type: "warning" });
            return;
        }

        const stepIndex = (this.state.recorderStepIndex || 0) + 1;
        const stepId = (crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);
        const payload = {
            recorder_session_id: this.state.recorderSessionId,
            step_id: stepId,
            step_index: stepIndex,
            timestamp: new Date().toISOString(),
            instruction: instruction || "",
            target: picked?.target_key || null,
            target_meta: picked || null,
            context: this.state.currentContext || null,
        };

        // dedupe básico en frontend
        const dedupeKey = [
            payload.recorder_session_id,
            payload.step_index,
            payload.target || "",
            payload.instruction || "",
        ].join("|");

        if (this._savedStepHashes.has(dedupeKey)) {
            this.notification.add(_t("Duplicate step ignored."), { type: "warning" });
            return;
        }
        this._savedStepHashes.add(dedupeKey);

        try {
            // ✅ SOLO AQUÍ se manda por WS
            await this.aiWs.sendEvent({
                type: "exercise_step",
                event_name: "step_saved",
                event_data: payload,
            });

            // ✅ SOLO AQUÍ entra al feed
            this._pushSavedStepToFeed(payload);

            this.state.recorderStepIndex = stepIndex;
            this.state.recorderNote = "";
            this.state.recorderPicked = null;

            this.notification.add(_t("Step saved."), { type: "success" });
        } catch (e) {
            console.warn("[recorder] save step failed:", e);
            // ❌ NO agregar WS_ERROR al feed
            this.notification.add(_t("Could not save step to WebSocket."), { type: "danger" });
        }
    }

    _getNluxMessageEl(chatItemEl) {
        // Contenedor donde NLUX renderiza el contenido del mensaje
        return (
            chatItemEl.querySelector(".nlux-markdown-container") ||
            chatItemEl.querySelector(".nlux-comp-message") ||
            chatItemEl
        );
    }

    _getMessageBody(chatItemEl) {
        const md = chatItemEl.querySelector(".nlux-markdown-container");
        if (!md) {
            return { html: "", text: "" };
        }
        const html = md.innerHTML || "";
        const text = (md.innerText || md.textContent || "").trim();
        return { html, text };
    }

    _extractMessageBody(chatItemEl) {
        const el = this._getNluxMessageEl(chatItemEl);
        const html = (el?.innerHTML || "").trim();
        const text = (el?.textContent || "").trim();
        return { html, text };
    }

    _initFeedbackObserver() {
        if (this._feedbackObserver) return;

        const root = this.chatUiRef?.el;
        if (!root) return;

        const attachToExisting = () => {
            root
                .querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received")
                .forEach((item) => this._injectFeedbackBar(item));
        };

        attachToExisting();

        this._feedbackObserver = new MutationObserver(() => {
            attachToExisting();
        });

        this._feedbackObserver.observe(root, { childList: true, subtree: true });
    }

    _setComposerAutoFocus(enabled) {
        try {
            if (this.aiChat?.updateComposerOptions) {
                this.aiChat.updateComposerOptions({ autoFocus: !!enabled });
            }
        } catch (e) {}

        // Blur del input del composer (NLUX)
        const composerInput =
            this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea, .nlux-composer-container input");
        if (!enabled && composerInput) composerInput.blur();
    }

    _teardownFeedbackObserver() {
        if (this._feedbackObserver) {
            this._feedbackObserver.disconnect();
            this._feedbackObserver = null;
        }
        this._closeFeedbackPopover();
    }

    _getNluxMessageUid(chatItemEl) {
        // nlux pone nlux-message-id en el contenedor markdown
        const msg = chatItemEl.querySelector(".nlux-markdown-container[nlux-message-id]");
        return msg?.getAttribute("nlux-message-id") || null;
    }

    _injectFeedbackBar(chatItemEl) {
        if (!(chatItemEl instanceof Element)) return;
        if (!chatItemEl.classList.contains("nlux-comp-chatItem--received")) return;
        if (chatItemEl.querySelector(":scope .ai_feedback_bar")) return;

        const uid = this._getNluxMessageUid(chatItemEl) || `no_uid_${Date.now()}`;
        const messageRoot = chatItemEl.querySelector(":scope .nlux-comp-message") || chatItemEl;

        const bar = document.createElement("div");
        bar.className = "ai_feedback_bar";
        bar.dataset.messageUid = uid;

        bar.innerHTML = `
            <button type="button" class="ai_feedback_btn" data-action="up" title="${_t("Helpful answer")}">
                <i class="fa fa-thumbs-up"></i>
            </button>
            <button type="button" class="ai_feedback_btn" data-action="down" title="${_t("Not helpful")}">
                <i class="fa fa-thumbs-down"></i>
            </button>
            <button type="button" class="ai_feedback_btn" data-action="comment" title="${_t("Leave a comment")}">
                <i class="fa fa-comment"></i>
            </button>
        `;

        bar.addEventListener("click", (ev) => {
            const btn = ev.target.closest("button.ai_feedback_btn");
            if (!btn) return;

            const action = btn.dataset.action;
            const messageUid = bar.dataset.messageUid;

            const { html, text } = this._getMessageBody(chatItemEl);

            if (action === "up") {
                this._setSelectedVote(bar, "up");
                this._submitAiFeedback({
                    message_uid: messageUid,
                    vote: "up",
                    comment: "",
                    message_body_html: html,
                    message_body_text: text,
                });
            } else if (action === "down") {
                this._setSelectedVote(bar, "down");
                this._submitAiFeedback({
                    message_uid: messageUid,
                    vote: "down",
                    comment: "",
                    message_body_html: html,
                    message_body_text: text,
                });
            } else if (action === "comment") {
                this._toggleFeedbackQuickPopover({
                    chatItemEl,
                    anchorBtn: btn,
                    messageUid,
                    messageHtml: html,
                    messageText: text,
                });
            }
        });

        messageRoot.appendChild(bar);
    }

    _setSelectedVote(barEl, vote) {
        barEl.querySelectorAll(".ai_feedback_btn").forEach((b) => b.classList.remove("is-active"));
        const target = barEl.querySelector(`.ai_feedback_btn[data-action="${vote}"]`);
        if (target) target.classList.add("is-active");
    }

    _toggleFeedbackQuickPopover({ chatItemEl, anchorBtn, messageUid, messageHtml, messageText }) {
        // si ya hay algo abierto, ciérralo primero
        if (this._activeFeedbackPopover) {
            this._closeFeedbackPopover();
        }

        const portal = this.chatUiRef?.el || this.containerRef?.el;
        if (!portal || !anchorBtn) return;

        const pop = document.createElement("div");
        pop.className = "ai_feedback_popover ai_feedback_popover--quick";
        pop.dataset.messageUid = messageUid;

        pop.innerHTML = `
          <div class="ai_feedback_popover_title">Quick feedback</div>

          <div class="ai_feedback_quick_grid">
            <button type="button" class="ai_feedback_quick_btn" data-act="excellent">
              <i class="fa fa-star"></i><span>Excellent</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="unclear">
              <i class="fa fa-question-circle"></i><span>Unclear</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="technical">
              <i class="fa fa-wrench"></i><span>Technical issue</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="comment">
              <i class="fa fa-comment"></i><span>Comment</span>
            </button>
          </div>

          <div class="ai_feedback_actions">
            <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">Cancel</button>
          </div>
        `;

        // no romper NLUX
        const stopOnly = (e) => e.stopPropagation();
        pop.addEventListener("pointerdown", stopOnly, true);
        pop.addEventListener("mousedown", stopOnly, true);
        pop.addEventListener("keydown", stopOnly, true);

        portal.appendChild(pop);

        // mismo comportamiento visual que el popover actual
        pop.style.position = "fixed";
        pop.style.zIndex = "10000";
        pop.style.pointerEvents = "auto";

        this._setComposerAutoFocus(false);

        const place = () => {
            const r = anchorBtn.getBoundingClientRect();
            let left = r.left;
            let top = r.bottom + 8;

            const pr = pop.getBoundingClientRect();
            const pad = 8;

            if (left + pr.width > window.innerWidth - pad) left = window.innerWidth - pr.width - pad;
            if (left < pad) left = pad;

            if (top + pr.height > window.innerHeight - pad) top = r.top - pr.height - pad;
            if (top < pad) top = pad;

            pop.style.left = `${left}px`;
            pop.style.top = `${top}px`;
        };

        place();
        requestAnimationFrame(place);

        // acciones
        const onClick = (ev) => {
            const btn = ev.target.closest("button");
            if (!btn) return;

            const act = btn.dataset.act;
            if (!act) return;

            // ✅ cerrar el quick popover antes de abrir el textarea
            const closeAndOpenTextarea = (opts) => {
                this._closeFeedbackPopover();
                this._toggleFeedbackPopover({
                    chatItemEl,
                    anchorBtn,
                    messageUid,
                    messageHtml,
                    messageText,
                    ...opts,
                });
            };

            if (act === "cancel") {
                this._closeFeedbackPopover();
                return;
            }

            if (act === "excellent") {
                // enviar directo (sin textarea)
                this._submitAiFeedback(
                    {
                        message_uid: messageUid,
                        vote: "up",
                        comment: "",
                        message_body_html: messageHtml,
                        message_body_text: messageText,
                    },
                    { eventName: "ai_feedback" }
                );

                this._closeFeedbackPopover();
                return;
            }

            if (act === "unclear") {
                closeAndOpenTextarea({
                    eventName: "ai_feedback_unclear",
                    title: "What was unclear?",
                    placeholder: "Tell us what felt confusing or incomplete...",
                    presetVote: "down",
                });
                return;
            }

            if (act === "technical") {
                closeAndOpenTextarea({
                    eventName: "ai_feedback_technical_issue",
                    title: "Describe the technical issue",
                    placeholder: "What went wrong? (error, stuck, wrong output, etc.)",
                    presetVote: "",
                });
                return;
            }

            if (act === "comment") {
                closeAndOpenTextarea({
                    eventName: "ai_feedback",
                    title: "Feedback about this answer",
                    placeholder: "Tell us what we can improve...",
                    presetVote: "",
                });
                return;
            }
        };

        pop.addEventListener("click", onClick, true);

        // cerrar al click afuera
        const onDocMouseDown = (e) => {
            if (!pop.contains(e.target) && e.target !== anchorBtn) {
                this._closeFeedbackPopover();
            }
        };
        const onKeyDown = (e) => {
            if (e.key === "Escape") this._closeFeedbackPopover();
        };

        document.addEventListener("mousedown", onDocMouseDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("resize", place, true);
        window.addEventListener("scroll", place, true);

        this._activeFeedbackPopover = pop;
        pop._onDocMouseDown = onDocMouseDown;
        pop._onKeyDown = onKeyDown;
        pop._onReflow = place;
        pop._onQuickClick = onClick;
    }

    _toggleFeedbackPopover({
    chatItemEl,
    anchorBtn,
    messageUid,
    messageHtml,
    messageText,

    // ✅ nuevos
    eventName = "ai_feedback",
    title = _t("Feedback about this answer"),
    placeholder = _t("Tell us what we can improve..."),
    presetVote = "",
    }) {
        // toggle si es el mismo
        if (this._activeFeedbackPopover) {
            if (this._activeFeedbackPopover.dataset.messageUid === messageUid) {
              this._closeFeedbackPopover();
              return;
            }
            this._closeFeedbackPopover();
        }

        const portal = this.chatUiRef?.el || this.containerRef?.el;
        if (!portal || !anchorBtn) return;

        const pop = document.createElement("div");
        pop.className = "ai_feedback_popover";
        pop.dataset.messageUid = messageUid;

        // ✅ guarda config para el send
        pop.dataset.eventName = eventName;
        pop.dataset.presetVote = presetVote;

        pop.innerHTML = `
        <div class="ai_feedback_popover_title">${title}</div>
        <textarea class="ai_feedback_text" rows="3"
          placeholder="${placeholder}"></textarea>
        <div class="ai_feedback_actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="send">${_t("Send")}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">${_t("Cancel")}</button>
        </div>
        `;

        const stopOnly = (e) => e.stopPropagation();
        pop.addEventListener("pointerdown", stopOnly, true);
        pop.addEventListener("mousedown", stopOnly, true);
        pop.addEventListener("keydown", stopOnly, true);

        portal.appendChild(pop);

        pop.style.position = "fixed";
        pop.style.zIndex = "10000";
        pop.style.pointerEvents = "auto";

        this._setComposerAutoFocus(false);

        const place = () => {
        const r = anchorBtn.getBoundingClientRect();
        let left = r.left;
        let top = r.bottom + 8;

        const pr = pop.getBoundingClientRect();
        const pad = 8;

        if (left + pr.width > window.innerWidth - pad) left = window.innerWidth - pr.width - pad;
        if (left < pad) left = pad;

        if (top + pr.height > window.innerHeight - pad) top = r.top - pr.height - pad;
        if (top < pad) top = pad;

        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        };

        place();
        requestAnimationFrame(place);

        const ta = pop.querySelector(".ai_feedback_text");
        if (ta) {
        ta.tabIndex = 0;
        ta.style.pointerEvents = "auto";
        setTimeout(() => ta.focus({ preventScroll: true }), 0);
        }

        const btnSend = pop.querySelector('button[data-act="send"]');
        const btnCancel = pop.querySelector('button[data-act="cancel"]');

        const onSend = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const text = ta?.value?.trim() || "";
        const eventNameFinal = pop.dataset.eventName || "ai_feedback";
        const voteFinal = pop.dataset.presetVote || "";

        // ✅ manda con el eventName correcto
        this._submitAiFeedback(
          {
            message_uid: messageUid,
            comment: text,
            vote: voteFinal,
            message_body_html: messageHtml,
            message_body_text: messageText,
          },
          { eventName: eventNameFinal }
        );

        this._closeFeedbackPopover();
        };

        const onCancel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._closeFeedbackPopover();
        };

        btnSend?.addEventListener("click", onSend, true);
        btnCancel?.addEventListener("click", onCancel, true);

        const onDocMouseDown = (e) => {
        if (!pop.contains(e.target) && e.target !== anchorBtn) {
          this._closeFeedbackPopover();
        }
        };

        const onKeyDown = (e) => {
        if (e.key === "Escape") this._closeFeedbackPopover();
        };

        document.addEventListener("mousedown", onDocMouseDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("resize", place, true);
        window.addEventListener("scroll", place, true);

        this._activeFeedbackPopover = pop;
        pop._onDocMouseDown = onDocMouseDown;
        pop._onKeyDown = onKeyDown;
        pop._onReflow = place;
        pop._onSend = onSend;
        pop._onCancel = onCancel;
    }

    _closeFeedbackPopover() {
        if (!this._activeFeedbackPopover) return;
        const pop = this._activeFeedbackPopover;

        document.removeEventListener("mousedown", pop._onDocMouseDown, true);
        document.removeEventListener("keydown", pop._onKeyDown, true);
        window.removeEventListener("resize", pop._onReflow, true);
        window.removeEventListener("scroll", pop._onReflow, true);

        const btnSend = pop.querySelector('button[data-act="send"]');
        const btnCancel = pop.querySelector('button[data-act="cancel"]');
        btnSend?.removeEventListener("click", pop._onSend, true);
        btnCancel?.removeEventListener("click", pop._onCancel, true);

        this._setComposerAutoFocus(true);

        pop.remove();
        this._activeFeedbackPopover = null;
    }

    async _sendFeedbackToWs(payload, extra = {}) {
        const wsPayload = {
            type: "feedback_event",
            event_name: "ai_feedback",
            event_data: {
                ...payload,
                ...extra,
                timestamp: new Date().toISOString(),
            },
        };

        try {
            if (window.aiTutorSend) {
                const sent = window.aiTutorSend(wsPayload);
                console.log("[AI tutor] feedback_event:", sent ? "sent" : "queued", wsPayload);
                return sent;
            }
            window.__AI_TUTOR_WS_QUEUE = window.__AI_TUTOR_WS_QUEUE || [];
            window.__AI_TUTOR_WS_QUEUE.push(wsPayload);
            console.log("[AI tutor] feedback_event queued (no bridge):", wsPayload);
            return false;
        } catch (e) {
            console.error("[AI tutor] feedback_event send failed:", e);
            return false;
        }
    }

    async _submitAiFeedback(payload, opts = {}) {
        const fullPayload = { ...payload, context: this.state.currentContext };
        const wsOnline = this.aiWs?.isOpen?.() || window.__AI_TUTOR_WS_STATUS?.status === "open";

        const eventName = opts?.eventName || "ai_feedback"; // ✅ default

        if (wsOnline) {
            this.notification.add(_t("Feedback sent via WebSocket ✅"), { type: "success" });
        } else {
            this.notification.add(_t("WebSocket offline. Feedback queued ⏳"), { type: "warning" });
        }

        return this.aiWs
            .sendEvent({
                type: "feedback_event",
                event_name: eventName, // ✅ override aquí
                event_data: fullPayload,
            })
            .catch((e) => console.warn("sendEvent failed:", e));
    }

    _waitAndInitAntiAutoScroll() {
        const root = this.chatUiRef?.el;
        if (!root) {
            return;
        }

        const tryInit = () => {
            const conv = root.querySelector(".nlux-conversation-container");
            const segs = root.querySelector(".nlux-chatSegments-container");
            if (conv && segs) {
                this._initAntiAutoScroll(conv, segs);
                this._disconnectContainerFinder();
                return true;
            }
            return false;
        };

        if (tryInit()) return;

        this._containerFinderObs = new MutationObserver(() => {
            tryInit();
        });
        this._containerFinderObs.observe(root, { childList: true, subtree: true });
        this._containerFinderTimer = setTimeout(() => {
            this._disconnectContainerFinder();
        }, 10000);
    }

    _disconnectContainerFinder() {
        if (this._containerFinderObs) {
            this._containerFinderObs.disconnect();
            this._containerFinderObs = null;
        }
        if (this._containerFinderTimer) {
            clearTimeout(this._containerFinderTimer);
            this._containerFinderTimer = null;
        }
    }

    _initAntiAutoScroll(conv, segments) {
        this._conv = conv;
        this._segments = segments;

        this._conv.style.overflowY = "auto";
        this._conv.style.maxHeight = "100%";
        this._conv.style.overflowAnchor = "none";
        this._conv.style.scrollBehavior = "auto";

        this._observerAA = new MutationObserver((mutations) => {
            let addedBotMsg = null;

            for (const m of mutations) {
                if (m.type !== "childList") continue;
                m.addedNodes.forEach((n) => {
                    if (!(n instanceof Element)) return;

                    const directBot = n.matches?.(".nlux-comp-chatItem.nlux-comp-chatItem--received") ? n : null;
                    const nestedBot = !directBot && n.querySelector?.(".nlux-comp-chatItem.nlux-comp-chatItem--received");
                    const candidate = directBot || nestedBot;
                    if (candidate) addedBotMsg = candidate;
                });
            }

            if (this._expectingAssistant && addedBotMsg) {
                this._expectingAssistant = false;
                this._anchorEl = addedBotMsg;
                this._startLockToAnchor();
            }

            if (this._lockActive && this._anchorEl) {
                this._stickToAnchor();
            }
        });

        this._observerAA.observe(this._segments, { childList: true, subtree: true });

        this._origScrollTo = this._conv.scrollTo;
        this._conv.scrollTo = (...args) => {
            if (this._lockActive) return;
            return this._origScrollTo?.apply(this._conv, args);
        };

        const proto = Object.getPrototypeOf(this._conv);
        this._origScrollTopDesc = Object.getOwnPropertyDescriptor(proto, "scrollTop");
        if (this._origScrollTopDesc) {
            Object.defineProperty(this._conv, "scrollTop", {
                configurable: true,
                get: () => this._origScrollTopDesc.get.call(this._conv),
                set: (v) => {
                    if (this._lockActive) return;
                    return this._origScrollTopDesc.set.call(this._conv, v);
                },
            });
        }
    }

    _teardownAntiAutoScroll() {
        if (this._observerAA) {
            this._observerAA.disconnect();
            this._observerAA = null;
        }
        this._stopLock();

        if (this._conv) {
            if (this._origScrollTo) this._conv.scrollTo = this._origScrollTo;
            if (this._origScrollTopDesc) {
                try {
                    Object.defineProperty(this._conv, "scrollTop", this._origScrollTopDesc);
                } catch {}
            }
            this._conv.style.overflowAnchor = "auto";
            this._conv.style.scrollBehavior = "auto";
        }

        this._conv = null;
        this._segments = null;
        this._origScrollTopDesc = null;
        this._origScrollTo = null;
    }

    _topWithin(el, container) {
        const r1 = el.getBoundingClientRect();
        const r2 = container.getBoundingClientRect();
        return r1.top - r2.top + container.scrollTop;
    }

    _stickToAnchor() {
        if (!this._conv || !this._anchorEl) return;
        const target = Math.max(0, this._topWithin(this._anchorEl, this._conv) - 8);


        this._conv.scrollTop = target;
        requestAnimationFrame(() => {
            this._conv.scrollTop = target;
            requestAnimationFrame(() => {
                this._conv.scrollTop = target;
            });
        });
    }

    _startLockToAnchor() {
        if (!this._anchorEl || !this._conv) return;
        this._lockActive = true;

        this._origWindowScrollTo = window.scrollTo;
        window.scrollTo = (...args) => {
            if (this._lockActive) return;
            return this._origWindowScrollTo?.apply(window, args);
        };

        this._origScrollIntoView = Element.prototype.scrollIntoView;
        const conv = this._conv;
        Element.prototype.scrollIntoView = function (...args) {
            try {
                if (conv && conv.contains(this)) return;
            } catch (e) {}
            return AiSidebar.prototype._origScrollIntoView.call(this, ...args);
        };
        AiSidebar.prototype._origScrollIntoView = this._origScrollIntoView;

        const lockMs = 3000;
        const start = performance.now();

        const tick = () => {
            if (!this._lockActive) return;
            this._stickToAnchor();

            if (performance.now() - start < lockMs) {
                this._lockRaf = requestAnimationFrame(tick);
            } else {
                this._lockActive = false;
                if (this._origWindowScrollTo) window.scrollTo = this._origWindowScrollTo;
                if (AiSidebar.prototype._origScrollIntoView) {
                    Element.prototype.scrollIntoView = AiSidebar.prototype._origScrollIntoView;
                    AiSidebar.prototype._origScrollIntoView = null;
                }
            }
        };
        this._lockRaf = requestAnimationFrame(tick);
    }

    _stopLock() {
        this._lockActive = false;
        if (this._lockRaf) cancelAnimationFrame(this._lockRaf);
        this._lockRaf = null;
        this._anchorEl = null;

        if (this._origWindowScrollTo) {
            window.scrollTo = this._origWindowScrollTo;
            this._origWindowScrollTo = null;
        }
        if (AiSidebar.prototype._origScrollIntoView) {
            Element.prototype.scrollIntoView = AiSidebar.prototype._origScrollIntoView;
            AiSidebar.prototype._origScrollIntoView = null;
        }
    }

    startProcess() {
        this.state.processActive = true;
        this.state.timerSeconds = 0;
        this.state.timerValue = "00:00:00";

        this.state.timerInterval = setInterval(() => {
            this.state.timerSeconds++;

            const hours = Math.floor(this.state.timerSeconds / 3600);
            const minutes = Math.floor((this.state.timerSeconds % 3600) / 60);
            const seconds = this.state.timerSeconds % 60;

            this.state.timerValue =
                `${hours.toString().padStart(2, '0')}:` +
                `${minutes.toString().padStart(2, '0')}:` +
                `${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    cancelProcess() {
        clearInterval(this.state.timerInterval);
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseId = null;
        this.state.timerSeconds = 0;
        this.state.timerValue = "00:00:00";
    }

    async showResultModal() {
        this.state.finishLoading = true;

        try {
            const response = await fetch("/ai_chat/validate_exercise", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify({
                    exercise_id: this.state.exerciseId,
                }),
            });

            const responseText = await response.text();
            const jsonRpcResponse = JSON.parse(responseText);
            if (jsonRpcResponse.result && jsonRpcResponse.result.result) {
                const actualResult = JSON.parse(jsonRpcResponse.result.result);
                if (actualResult.details && actualResult.details.results) {
                    const results = actualResult.details.results;
                    const firstFailure = results.find((r) => r.status === "failed");

                    if (firstFailure) {
                        this.state.firstFailedStep = {
                            description: firstFailure.description,
                            details: firstFailure.details,
                        };
                        this.state.result = "failed";
                    } else {
                        this.state.result = "passed";
                        this.state.firstFailedStep = null;
                        this.cancelProcess();
                    }
                    this.state.finishLoading = false;
                    this.state.showResultModal = true;
                }
            }
        } catch (error) {
            console.error("Network error:", error);
        }
    }

    closeResultModal() {
        this.state.showResultModal = false;
        this.state.result = null;
        this.state.firstFailedStep = null;
    }

    selectResult(result) {
        if (result === "null") {
            this.state.result = result;
            setTimeout(() => {
                this.closeResultModal();
            }, 10000);
        }
    }

    toggleButtons() {
        this.state.showButtons = !this.state.showButtons;
    }

    updateChatPlaceholder(newPlaceholder) {
        if (this.aiChat && this.aiChat.updateComposerOptions) {
            this.aiChat.updateComposerOptions({
                placeholder: newPlaceholder,
            });
        }
    }

    async sendMessage(message, extras) {
        const data = await this.aiWs.chat({
            message,
            context: this.state.currentContext,
        });

        console.log("[sidebar] chat response:", data);

        const text = data?.response || "";
        return { result: { response: text, exercise_id: data?.exercise_id || null } };
    }

    createAiChat() {
        if (this.aiChat) {
            this.aiChat.unmount();
            delete this.aiChat;
        }

        const adapter = this.state.isStreamingMode
            ? { streamText: this.streamText.bind(this) }
            : { batchText: this.batchText.bind(this) };

        const { partnerId, writeDate } = user;
        const userAvatar = imageUrl("res.partner", partnerId, "avatar_256", { unique: writeDate });
        const theme = cookie.get("color_scheme");

        this.aiChat = globalThis["@nlux/core"]
            .createAiChat()
            .withAdapter(adapter)
            .withDisplayOptions({ colorScheme: theme })
            .withConversationOptions({
                historyPayloadSize: "max",
                conversationStarters: [],
            })
            .withComposerOptions({
                placeholder: this.state.placeholder,
                autoFocus: true,
            })
            .withPersonaOptions({
                assistant: {
                    name: "IAbot",
                    avatar: "/odoo_tutor/static/images/iabot.png",
                    tagline: "Your helpful AI assistant!",
                },
                user: {
                    name: user.name,
                    avatar: userAvatar,
                },
            })
            .withMessageOptions({
                waitTimeBeforeStreamCompletion: "never",
            });

        this.aiChat.mount(this.chatUiRef.el);

        this._waitAndInitAntiAutoScroll();
        this._initFeedbackObserver();

    }

    reset() {
        this.createAiChat();
        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.timerValue = "00:00:00";
    }

    async batchText(message, extras) {
        try {
            const response = await this.sendMessage(message, extras);
            const messageText = response.result.response;
            const exercise_id = response.result.exercise_id;

            if (exercise_id) {
                setTimeout(() => {
                    this.state.showButtons = true;
                    this.state.exerciseId = exercise_id;
                }, 0);
            }

            return new String(messageText);
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    async streamText(message, observer, extras) {
        try {
            this.onMessage = (content) => observer.next(String(content));
            this.onStop = () => observer.complete();

            const response = await this.sendMessage(message, extras);
            if (response.stream) {
                response.stream.pipeTo(
                    new WritableStream({
                        write: (chunk) => this.onMessage(chunk),
                        close: () => this.onStop(),
                    })
                );
            }
        } catch (error) {
            observer.error(`AI Error: ${error.message}`);
        }
    }

    toggleStreamingMode() {
        this.state.isStreamingMode = !this.state.isStreamingMode;
    }

    get isStreamingMode() {
        return this.state.isStreamingMode;
    }

    // #region Mouse Events
    onMouseDown(event) {
        event.preventDefault();

        if (!this.containerRef.el || !this.handleRef.el) {
            return;
        }

        this.state.isResizing = true;
        const bounds = this.containerRef.el.getBoundingClientRect();
        this.refW = bounds.width;
        this.refX = event.clientX;

        document.documentElement.style.cursor = "e-resize";

        this.handleRef.el.classList.add("bg-info");
    }

    onMouseMove(event) {
        event.preventDefault();
        const width = Math.min(
            Math.max(this.refW + (this.refX - event.clientX), 300),
            600
        );
        this.state.width = `${width}px`;
    }

    onMouseUp() {
        this.state.isResizing = false;
        document.documentElement.style.cursor = "default";
        this.handleRef.el.classList.remove("bg-info");
    }
    // #endregion
}

registry.category("main_components").add("AiSidebar", { Component: AiSidebar });
