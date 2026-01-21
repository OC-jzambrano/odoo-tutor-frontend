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
        });

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
        });

        const aiBotStreamListener = ({ message, stop }) => {
            if (stop && this.onStop) this.onStop();
            else if (!stop && this.onMessage) this.onMessage(message);
        };
        this.busService = this.env.services.bus_service;
        this.busService.subscribe("ai_bot_stream", aiBotStreamListener);

        onWillUnmount(() => {
            clearInterval(this.contextInterval);
            this.busService.unsubscribe("ai_bot_stream", aiBotStreamListener);
            if (this.state.timerInterval) clearInterval(this.state.timerInterval);
            this._teardownAntiAutoScroll();
            this._disconnectContainerFinder();
            this._teardownFeedbackObserver();
        });

        this.onHandleMouseDown = useMouseListeners({
            onMouseDown: this.onMouseDown,
            onMouseMove: this.onMouseMove,
            onMouseUp: this.onMouseUp,
        });
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
                this._toggleFeedbackPopover({
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
