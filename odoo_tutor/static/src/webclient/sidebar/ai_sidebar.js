/* eslint-disable */
/** @odoo-module **/
import { Component, onMounted, onWillUnmount, useEffect, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { cookie } from "@web/core/browser/cookie";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { imageUrl } from "@web/core/utils/urls";
import { useMouseListeners } from "../../core/utils";
import { _t } from "@web/core/l10n/translation";

export class AiSidebar extends Component {
    static template = "ai_chat.AiSidebar";
    static props = {};

    setup() {
        super.setup();

        this.contextService = useService("context_service");
        this.notification = useService("notification");
        this.aiWs = useService("ai_ws");
        this.aiRecorder = useService("ai_recorder");

        this.containerRef = useRef("container");
        this.chatUiRef = useRef("chat-ui");
        this.handleRef = useRef("handle");

        this._activeFeedbackPopover = null;
        this._feedbackObserver = null;

        this._expectingAssistant = false;
        this._lockActive = false;

        this._savedStepHashes = new Set();

        this.modelPlaceholders = {
            "sale.order": "You're creating a Quotation, want help?",
            "account.move": "Need help with this Invoice?",
            "project.task": "What do you need to know about this Task?",
            default: "How can I help you today?",
        };

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

            recorderStatus: "idle", // idle | recording | paused
            recorderSessionId: null,
            recorderFeed: [],
            recorderStepIndex: 0,
            recorderNote: "",
            recorderPicked: null,
            recorderPicking: false,

            wsStatus: "unknown",
            showRecorderPanel: false,
            canSeeRecorderToggle: false,
        });

        useEffect(
            (currentContext) => {
                if (!currentContext) return;

                const model = currentContext.model;
                const newPlaceholder = this.modelPlaceholders[model] || this.modelPlaceholders.default;

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
            if (el) {
                this._onShown = () => this._afterShown();
                this._onHidden = () => this._afterHidden();
                el.addEventListener("shown.bs.offcanvas", this._onShown);
                el.addEventListener("hidden.bs.offcanvas", this._onHidden);
            }

            this._loadRecorderPermission();

            // Context polling (ligero)
            this.contextInterval = setInterval(() => {
                const newContext = this.contextService.getContext();
                if (!newContext) return;
                if (!this.state.currentContext || JSON.stringify(newContext) !== JSON.stringify(this.state.currentContext)) {
                    this.state.currentContext = newContext;
                }
            }, 250);

            // composer size observer
            this.observer = new MutationObserver(() => {
                const root = this.chatUiRef?.el;
                if (!root) return;
                const composer = root.querySelector(".nlux-composer-container");
                if (composer) {
                    this.state.composerWidth = composer.offsetWidth;
                    this.state.composerHeight = composer.offsetHeight;
                }
            });
            if (this.chatUiRef?.el) {
                this.observer.observe(this.chatUiRef.el, { childList: true, subtree: true });
            }

            // recorder feed: solo STEP_SAVED (no te ensucia con WS_ERROR)
            this._recListener = (ev) => {
                this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
                if (!ev || ev.event_type !== "STEP_SAVED") return;

                const _id =
                    ev._id ||
                    ev.step_id ||
                    ev.event_id ||
                    `${Date.now()}_${Math.random().toString(16).slice(2)}`;

                if ((this.state.recorderFeed || []).some((x) => x?._id === _id)) return;

                this.state.recorderFeed = [{ ...ev, _id }, ...(this.state.recorderFeed || [])].slice(0, 60);
            };
            this.aiRecorder.subscribe(this._recListener);

            this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
        });

        onWillUnmount(() => {
            const el = this._getOffcanvasEl();
            if (el && this._onShown) el.removeEventListener("shown.bs.offcanvas", this._onShown);
            if (el && this._onHidden) el.removeEventListener("hidden.bs.offcanvas", this._onHidden);

            clearInterval(this.contextInterval);

            if (this.observer) this.observer.disconnect();
            this.observer = null;

            this._teardownAntiAutoScroll();
            this._teardownFeedbackObserver();

            document.body.classList.remove("o_ai_pick_mode");

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

    // -------------------------
    // Bootstrap Offcanvas helpers
    // -------------------------
    _getOffcanvasEl() {
        return this.containerRef?.el || document.getElementById("offcanvasAiSidebar");
    }

    _getBsOffcanvas() {
        const el = this._getOffcanvasEl();
        const Offcanvas = window.bootstrap?.Offcanvas;
        if (!el || !Offcanvas) return null;
        return Offcanvas.getOrCreateInstance(el, { backdrop: true, keyboard: true, scroll: false });
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

    _normalizeDomAfterTransitions() {
        const el = this._getOffcanvasEl();
        if (!el) return;
        el.classList.remove("hiding", "showing");
        el.style.removeProperty("visibility");
        el.style.removeProperty("pointer-events");
        el.style.removeProperty("transform");
        el.style.removeProperty("display");
    }

    _ensureBackdropVisible() {
        // Por si quedó pick_mode colgado
        document.body.classList.remove("o_ai_pick_mode");

        const el = this._getOffcanvasEl();
        if (!el || !el.classList.contains("show")) return;

        let bd = document.querySelector(".offcanvas-backdrop.show");
        if (!bd) bd = document.querySelector(".offcanvas-backdrop");

        if (!bd) {
            bd = document.createElement("div");
            bd.className = "offcanvas-backdrop fade show";
            document.body.appendChild(bd);
        } else {
            bd.classList.add("show");
            bd.style.removeProperty("display");
            bd.style.removeProperty("opacity");
            bd.style.removeProperty("visibility");
            bd.style.removeProperty("pointer-events");
        }
        document.body.classList.add("offcanvas-open");
    }

    _afterShown() {
        this._normalizeDomAfterTransitions();
        this._ensureBackdropVisible();

        // reflow NLUX si estamos en chat
        if (!this.state.showRecorderPanel) {
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        }
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    _afterHidden() {
        document.body.classList.remove("o_ai_pick_mode");
        this._normalizeDomAfterTransitions();

        // limpieza segura: solo si no hay ningún offcanvas abierto
        if (!document.querySelector(".offcanvas.show")) {
            document.querySelectorAll(".offcanvas-backdrop").forEach((b) => b.remove());
            document.body.classList.remove("offcanvas-open", "modal-open");
            document.body.style.removeProperty("overflow");
            document.body.style.removeProperty("padding-right");
        }

        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    async hideSidebar() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        document.body.classList.remove("o_ai_pick_mode");

        const bs = this._getBsOffcanvas();
        if (!bs) {
            el.classList.remove("show");
            return;
        }
        const p = this._waitEvent(el, "hidden.bs.offcanvas", 900);
        bs.hide();
        await p;
    }

    async showSidebar() {
        const el = this._getOffcanvasEl();
        if (!el) return;

        document.body.classList.remove("o_ai_pick_mode");

        const bs = this._getBsOffcanvas();
        if (!bs) {
            el.classList.add("show");
            this._ensureBackdropVisible();
            return;
        }
        const p = this._waitEvent(el, "shown.bs.offcanvas", 900);
        bs.show();
        await p;
        this._ensureBackdropVisible();
    }

    async onCloseSidebar() {
        await this.hideSidebar();
    }

    // -------------------------
    // Recorder / Pick
    // -------------------------
    async _loadRecorderPermission() {
        try {
            this.state.canSeeRecorderToggle = await user.hasGroup("base.group_system");
        } catch (e) {
            this.state.canSeeRecorderToggle = false;
        }
    }

    async toggleRecorderPanel() {
        if (!this.state.canSeeRecorderToggle) return;

        this.state.showRecorderPanel = !this.state.showRecorderPanel;
        this._closeFeedbackPopover?.();

        // reflow al volver a chat
        if (!this.state.showRecorderPanel) {
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            window.dispatchEvent(new Event("resize"));
        }
    }

    async onRecorderStart() {
        const sid = await this.aiRecorder.startRecording({ exerciseId: this.state.exerciseId || null });
        this.state.recorderSessionId = sid;
        this.state.recorderStatus = "recording";
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    async onRecorderPause() {
        await this.aiRecorder.pauseRecording();
        this.state.recorderStatus = "paused";
    }

    async onRecorderFinish() {
        const sid = this.state.recorderSessionId;
        try {
            await this.aiRecorder.finishRecording();
        } finally {
            // ✅ Limpieza total para nuevo ejercicio
            this.state.recorderStatus = "idle";
            this.state.recorderSessionId = null;
            this.state.recorderPicked = null;
            this.state.recorderPicking = false;
            this.state.recorderNote = "";
            this.state.recorderStepIndex = 0;
            this.state.recorderFeed = [];
            this._savedStepHashes = new Set();
            this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

            // opcional: notifica al backend
            try {
                await this.aiWs.sendEvent({
                    type: "exercise_event",
                    event_name: "recorder_finished",
                    event_data: { recorder_session_id: sid, exercise_id: this.state.exerciseId || null },
                });
            } catch {}
        }
    }

    onRecorderClearPick() {
        this.state.recorderPicked = null;
    }

    async onRecorderPick() {
        if (this.state.recorderStatus === "idle" || this.state.recorderPicking) return;

        this.state.recorderPicking = true;

        // 1) cerrar el offcanvas “bien” (bootstrap)
        await this.hideSidebar();

        // 2) activar pick mode SOLO mientras está cerrado
        document.body.classList.add("o_ai_pick_mode");

        try {
            const picked = await this.aiRecorder.pickTarget({ timeoutMs: 30000 });
            if (picked) this.state.recorderPicked = picked;
        } catch (e) {
            console.warn("[ai_recorder] pick failed:", e);
        } finally {
            // 3) quitar pick mode + reabrir
            document.body.classList.remove("o_ai_pick_mode");
            await this.showSidebar();

            this.state.recorderPicking = false;
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
        this.state.recorderFeed = [item, ...(this.state.recorderFeed || [])].slice(0, 60);
    }

    async onRecorderSaveStep() {
        if (this.state.recorderStatus === "idle") return;

        const instruction = (this.state.recorderNote || "").trim();
        const picked = this.state.recorderPicked || null;

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
            await this.aiWs.sendEvent({
                type: "exercise_step",
                event_name: "step_saved",
                event_data: payload,
            });

            this._pushSavedStepToFeed(payload);

            this.state.recorderStepIndex = stepIndex;
            this.state.recorderNote = "";
            this.state.recorderPicked = null;

            this.notification.add(_t("Step saved."), { type: "success" });
        } catch (e) {
            console.warn("[recorder] save step failed:", e);
            this.notification.add(_t("Could not save step to WebSocket."), { type: "danger" });
        }
    }

    // -------------------------
    // Chat (NLUX)
    // -------------------------
    updateChatPlaceholder(newPlaceholder) {
        if (this.aiChat && this.aiChat.updateComposerOptions) {
            this.aiChat.updateComposerOptions({ placeholder: newPlaceholder });
        }
    }

    async sendMessage(message) {
        this._expectingAssistant = true;
        const data = await this.aiWs.chat({ message, context: this.state.currentContext });
        const text = data?.response || "";
        return { result: { response: text, exercise_id: data?.exercise_id || null } };
    }

    createAiChat() {
        if (this.aiChat) {
            try { this.aiChat.unmount(); } catch {}
            this.aiChat = null;
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
            .withConversationOptions({ historyPayloadSize: "max", conversationStarters: [] })
            .withComposerOptions({ placeholder: this.state.placeholder, autoFocus: true })
            .withPersonaOptions({
                assistant: { name: "IAbot", avatar: "/odoo_tutor/static/images/iabot.png", tagline: "Your helpful AI assistant!" },
                user: { name: user.name, avatar: userAvatar },
            })
            .withMessageOptions({ waitTimeBeforeStreamCompletion: "never" });

        this.aiChat.mount(this.chatUiRef.el);

        this._waitAndInitAntiAutoScroll();
        this._initFeedbackObserver();
    }

    async reset() {
        // reset chat UI
        this.createAiChat();

        // reset process UI
        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.timerValue = "00:00:00";

        // ✅ reinicia WS de verdad
        try {
            await this.aiWs.restart({ reason: "ui_reset" });
        } catch (e) {
            console.warn("[ai_sidebar] ws restart failed:", e);
        }
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    async batchText(message) {
        try {
            const response = await this.sendMessage(message);
            const messageText = response.result.response;
            const exercise_id = response.result.exercise_id;

            if (exercise_id) {
                this.state.showButtons = true;
                this.state.exerciseId = exercise_id;
            }
            return new String(messageText);
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    async streamText(message, observer) {
        try {
            this.onMessage = (content) => observer.next(String(content));
            this.onStop = () => observer.complete();

            const response = await this.sendMessage(message);
            if (response.stream) {
                response.stream.pipeTo(new WritableStream({
                    write: (chunk) => this.onMessage(chunk),
                    close: () => this.onStop(),
                }));
            }
        } catch (error) {
            observer.error(`AI Error: ${error.message}`);
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
                `${hours.toString().padStart(2, "0")}:` +
                `${minutes.toString().padStart(2, "0")}:` +
                `${seconds.toString().padStart(2, "0")}`;
        }, 1000);
    }

    cancelProcess() {
        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
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
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ exercise_id: this.state.exerciseId }),
            });

            const jsonRpcResponse = JSON.parse(await response.text());
            const actualResult = JSON.parse(jsonRpcResponse?.result?.result || "{}");

            const results = actualResult?.details?.results || [];
            const firstFailure = results.find((r) => r.status === "failed");

            if (firstFailure) {
                this.state.firstFailedStep = { description: firstFailure.description, details: firstFailure.details };
                this.state.result = "failed";
            } else {
                this.state.result = "passed";
                this.state.firstFailedStep = null;

                // ✅ al pasar: limpia para nuevo ejercicio
                this.cancelProcess();
                this.state.recorderFeed = [];
                this.state.recorderStepIndex = 0;
                this._savedStepHashes = new Set();
                this.state.recorderPicked = null;
            }

            this.state.showResultModal = true;
        } catch (error) {
            console.error("Network error:", error);
        } finally {
            this.state.finishLoading = false;
        }
    }

    closeResultModal() {
        this.state.showResultModal = false;
        this.state.result = null;
        this.state.firstFailedStep = null;
    }

    // -------------------------
    // Anti auto-scroll (tu lógica)
    // -------------------------
    _waitAndInitAntiAutoScroll() {
        const root = this.chatUiRef?.el;
        if (!root) return;

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

        this._containerFinderObs = new MutationObserver(() => tryInit());
        this._containerFinderObs.observe(root, { childList: true, subtree: true });
        this._containerFinderTimer = setTimeout(() => this._disconnectContainerFinder(), 10000);
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
            if (this._lockActive && this._anchorEl) this._stickToAnchor();
        });

        this._observerAA.observe(this._segments, { childList: true, subtree: true });
    }

    _teardownAntiAutoScroll() {
        if (this._observerAA) {
            this._observerAA.disconnect();
            this._observerAA = null;
        }
        this._stopLock?.();
        this._conv = null;
        this._segments = null;
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
        requestAnimationFrame(() => (this._conv.scrollTop = target));
    }

    _startLockToAnchor() {
        if (!this._anchorEl || !this._conv) return;
        this._lockActive = true;

        const lockMs = 2500;
        const start = performance.now();

        const tick = () => {
            if (!this._lockActive) return;
            this._stickToAnchor();

            if (performance.now() - start < lockMs) {
                this._lockRaf = requestAnimationFrame(tick);
            } else {
                this._lockActive = false;
            }
        };
        this._lockRaf = requestAnimationFrame(tick);
    }

    // -------------------------
    // Feedback (dejas tu UI igual; aquí solo mantenemos el hook)
    // -------------------------
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

        this._feedbackObserver = new MutationObserver(() => attachToExisting());
        this._feedbackObserver.observe(root, { childList: true, subtree: true });
    }

    _teardownFeedbackObserver() {
        if (this._feedbackObserver) {
            this._feedbackObserver.disconnect();
            this._feedbackObserver = null;
        }
        this._closeFeedbackPopover?.();
    }

    _getNluxMessageUid(chatItemEl) {
        const msg = chatItemEl.querySelector(".nlux-markdown-container[nlux-message-id]");
        return msg?.getAttribute("nlux-message-id") || null;
    }

    _getMessageBody(chatItemEl) {
        const md = chatItemEl.querySelector(".nlux-markdown-container");
        if (!md) return { html: "", text: "" };
        return { html: md.innerHTML || "", text: (md.innerText || md.textContent || "").trim() };
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
                this._submitAiFeedback({ message_uid: messageUid, vote: "up", comment: "", message_body_html: html, message_body_text: text });
            } else if (action === "down") {
                this._submitAiFeedback({ message_uid: messageUid, vote: "down", comment: "", message_body_html: html, message_body_text: text });
            } else if (action === "comment") {
                // deja tu popover real aquí si lo necesitas
                this.notification.add(_t("Comment UI not included in this compact version."), { type: "info" });
            }
        });

        messageRoot.appendChild(bar);
    }

    async _submitAiFeedback(payload, opts = {}) {
        const fullPayload = { ...payload, context: this.state.currentContext };
        const eventName = opts?.eventName || "ai_feedback";
        return this.aiWs.sendEvent({
            type: "feedback_event",
            event_name: eventName,
            event_data: fullPayload,
        }).catch(() => {});
    }

    // -------------------------
    // Resize
    // -------------------------
    onMouseDown(event) {
        event.preventDefault();
        if (!this.containerRef.el || !this.handleRef.el) return;

        this.state.isResizing = true;
        const bounds = this.containerRef.el.getBoundingClientRect();
        this.refW = bounds.width;
        this.refX = event.clientX;

        document.documentElement.style.cursor = "e-resize";
        this.handleRef.el.classList.add("bg-info");
    }

    onMouseMove(event) {
        event.preventDefault();
        const width = Math.min(Math.max(this.refW + (this.refX - event.clientX), 300), 600);
        this.state.width = `${width}px`;
    }

    onMouseUp() {
        this.state.isResizing = false;
        document.documentElement.style.cursor = "default";
        this.handleRef.el.classList.remove("bg-info");
    }
}

registry.category("main_components").add("AiSidebar", { Component: AiSidebar });
