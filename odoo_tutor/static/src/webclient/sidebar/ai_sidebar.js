/* eslint-disable */
/** @odoo-module **/

import { Component, onMounted, onWillUnmount, proxy, signal, useLayoutEffect } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { cookie } from "@web/core/browser/cookie";
import { useService } from "@web/core/utils/hooks";
import { rpc } from "@web/core/network/rpc";
import { user } from "@web/core/user";
import { imageUrl } from "@web/core/utils/urls";
import { useMouseListeners } from "../../core/utils";
import { _t } from "@web/core/l10n/translation";
import {
    buildSkipStepRequest,
    getVisibleSkipResponse,
} from "../../core/skip_step";
import {
    buildCopySegments,
    normalizeForCopyTargetLookup,
    stripNewlinesAroundCopyTargets,
} from "../../core/copy_targets";
import { shouldQueueTutorMessage } from "../../core/tutor_message_delivery";

const TUTOR_PUSH_TYPES = new Set([
    "tutor_push",
    "instruction_push",
    "reinforce_push",
    "exercise_completed_push",
    "welcome_push",
    "drift_checkin_push",
]);

const INLINE_HINT_AUTO_HIDE_MS = 15000;

function makeRef() {
    const ref = signal(null);
    Object.defineProperty(ref, "el", { get: () => ref() });
    return ref;
}

function formatTimeAgo(ts) {
    if (!ts) return "";
    const now = Date.now();
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return "";

    const diffSec = Math.max(0, Math.floor((now - then) / 1000));

    if (diffSec < 10) return _t("just now");
    if (diffSec < 60) return _t("%s seconds ago", diffSec);

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin === 1) return _t("1 minute ago");
    if (diffMin < 60) return _t("%s minutes ago", diffMin);

    const diffHour = Math.floor(diffMin / 60);
    if (diffHour === 1) return _t("1 hour ago");
    if (diffHour < 24) return _t("%s hours ago", diffHour);

    const diffDay = Math.floor(diffHour / 24);
    if (diffDay === 1) return _t("1 day ago");
    return _t("%s days ago", diffDay);
}

function normalizeAssistantTextForCompare(text) {
    return String(text || "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getTutorPendingQueue() {
    window.__AI_TUTOR_PENDING_QUEUE__ = window.__AI_TUTOR_PENDING_QUEUE__ || [];
    return window.__AI_TUTOR_PENDING_QUEUE__;
}

const COPY_TARGETS_REGISTRY_MAX_SIZE = 30;

function getCopyTargetsRegistry() {
    window.__AI_TUTOR_COPY_TARGETS__ = window.__AI_TUTOR_COPY_TARGETS__ || new Map();
    return window.__AI_TUTOR_COPY_TARGETS__;
}

function cleanText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function translateKnownTutorText(value) {
    const cleaned = cleanText(value);
    const normalized = normalizeAssistantTextForCompare(cleaned);

    if (normalized === "do you want to continue the exercise?") {
        return _t("Do you want to continue the exercise?");
    }

    return cleaned;
}

function normalizeTutorTimestamp(ts) {
    const now = Date.now();

    if (!ts) {
        return new Date(now).toISOString();
    }

    let parsed = NaN;

    if (typeof ts === "number") {
        parsed = ts < 1e12 ? ts * 1000 : ts;
    } else {
        const raw = String(ts).trim();

        if (/^\d+(\.\d+)?$/.test(raw)) {
            const n = Number(raw);
            parsed = n < 1e12 ? n * 1000 : n;
        } else {
            parsed = new Date(raw).getTime();
        }
    }

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return new Date(now).toISOString();
    }

    if (parsed > now + 5 * 60 * 1000 || parsed < now - 30 * 24 * 60 * 60 * 1000) {
        return new Date(now).toISOString();
    }

    return new Date(parsed).toISOString();
}

function getCurrentColorScheme() {
    const doc = document.documentElement;
    const body = document.body;
    const dataScheme = doc?.dataset?.colorScheme || body?.dataset?.colorScheme;
    if (dataScheme === "dark" || dataScheme === "light") {
        return dataScheme;
    }

    if (doc?.classList?.contains("o_dark") || body?.classList?.contains("o_dark")) {
        return "dark";
    }

    // Odoo can leave the color_scheme cookie set to "dark" even while the
    // active client view is light. Use the rendered Odoo surfaces before that
    // fallback so the tutor follows what the user is actually seeing.
    for (const element of [
        document.querySelector(".o_action_manager"),
        document.querySelector(".o_web_client"),
        body,
        doc,
    ]) {
        if (!element) continue;
        const background = getComputedStyle(element).backgroundColor;
        const channels = background.match(/[\d.]+/g)?.map(Number);
        if (!channels || channels.length < 3 || (channels[3] !== undefined && channels[3] === 0)) {
            continue;
        }
        const [red, green, blue] = channels;
        const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
        if (luminance > 0.72) return "light";
        if (luminance < 0.35) return "dark";
    }

    const scheme = cookie.get("color_scheme");
    if (scheme === "dark" || scheme === "light") {
        return scheme;
    }

    return "light";
}

const TUTOR_ASSISTANT_AVATAR_URL = "/odoo_tutor/static/images/iabotv2.png";
const ACTIVE_EXERCISE_STORAGE_KEY = "odoo_tutor.active_exercise_session";
const ACTIVE_EXERCISE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const EXERCISE_CTA_STATE_KEY = "__AI_TUTOR_EXERCISE_CTA__";
const EXERCISE_CTA_EVENT = "ai:exercise_cta_update";
const EXERCISE_CHOICE_EVENT = "ai:exercise_choice";
const SIDEBAR_CLOSED_EVENT = "ai:sidebar_closed";
const EXERCISE_SKIP_STEP_EVENT = "ai:exercise_skip_step";

function getExerciseCtaState() {
    window[EXERCISE_CTA_STATE_KEY] = window[EXERCISE_CTA_STATE_KEY] || {
        exerciseId: null,
        visible: false,
        status: "",
        updatedAt: null,
    };
    return window[EXERCISE_CTA_STATE_KEY];
}

export class AiSidebar extends Component {
    static template = "ai_chat.AiSidebar";

    setup() {
        super.setup();
        // Services
        this.contextService = useService("context_service");
        this.notification = useService("notification");
        this.aiWs = useService("ai_ws");
        this.aiRecorder = useService("ai_recorder");
        this.aiChatStore = useService("ai_chat_store");
        this.rpc = rpc;
        // Refs
        this.containerRef = makeRef();
        this.chatPanelRef = makeRef();
        this.chatUiRef = makeRef();
        this.handleRef = makeRef();
        this.inlineHintRef = makeRef();

        this._offcanvasQueue = Promise.resolve();
        // Internal
        this._activeFeedbackPopover = null;
        this._feedbackObserver = null;
        this._copyButtonsObserver = null;
        this._composerOverflowInput = null;
        this._composerOverflowHandler = null;
        this._exerciseActionsScheduleVersion = 0;
        this._timerStartedAtMs = null;
        this._chatLayoutSyncRaf = null;
        this._conversationReadSyncTimer = null;

        // key -> timestamp
        this._seenTutorPush = new Map();
        this._tutorPushTtlMs = 8000;
        this._lastInjectedTutorText = null;
        this._lastInjectedTutorAt = 0;
        this._contextAckSubscribed = false;

        // anti-auto-scroll lock
        this._expectingAssistant = false;
        this._lockActive = false;
        this._lockRaf = null;
        this._anchorEl = null;
        this._userScrollingUntil = 0;
        this._onManualConversationScroll = null;
        this._onConversationReadScroll = null;

        // recorder step dedupe
        this._savedStepHashes = new Set();

        // placeholders per model
        this.modelPlaceholders = {
            "sale.order": _t("You're creating a Quotation, want help?"),
            "account.move": _t("Need help with this Invoice?"),
            "project.task": _t("What do you need to know about this Task?"),
            default: _t("How can I help you today?"),
        };
        // State
        this.state = proxy({
            width: "600px",
            isResizing: false,
            isStreamingMode: false,
            isLoading: false,

            colorScheme: getCurrentColorScheme(),
            currentContext: null,
            breadcrumbPath: "",
            placeholder: this.modelPlaceholders.default,
            composerHeight: 0,
            composerTopOffset: 0,
            composerWidth: 0,
            isChatInitialized: false,

            processActive: false,
            timerValue: "00:00:00",
            timerInterval: null,
            timerSeconds: 0,
            timerPaused: false,
            timerPausedReason: "",
            showButtons: false,

            showResultModal: false,
            exerciseId: null,
            exerciseChoicePending: false,
            exerciseCtaStatus: "",
            exerciseCancelLoading: false,
            skipStepEnabled: this.aiWs?.enableSkipStep === true,
            skipStepLoading: false,
            firstFailedStep: null,
            finishLoading: false,
            result: "failed",

            // idle | recording | paused
            recorderStatus: "idle",
            recorderSessionId: null,
            recorderFeed: [],
            recorderStepIndex: 0,
            recorderNote: "",
            recorderPicked: null,
            recorderPicking: false,

            wsStatus: "unknown",
            showRecorderPanel: false,
            canSeeRecorderToggle: false,

            hintMessage: "",
            hintTimestamp: null,
            hintVisible: false,
            hintHovered: false,
            hintExiting: false,
            hintCycle: 0,
        });

        window.aiTutorDebug = window.aiTutorDebug || {};

        window.aiTutorDebug.showHint = (text, timestamp = new Date().toISOString()) => {
            this._setInlineHint(text, timestamp);
        };

        window.aiTutorDebug.hideHint = () => {
            this.closeInlineHint();
        };

        window.aiTutorDebug.pushTutorMessage = (
            text,
            copyTargets = [],
            timestamp = new Date().toISOString()
        ) => {
            this._onTutorPush?.({
                type: "tutor_push",
                response: text,
                copy_targets: copyTargets,
                timestamp,
            });
        };
        // React to context changes
        useLayoutEffect(
            (currentContext) => {
                if (!currentContext) return;

                const model = currentContext.model;
                const newPlaceholder = this.modelPlaceholders[model] || this.modelPlaceholders.default;

                this._sendCurrentLiveContext();

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

        this._setInlineHint = (text, timestamp) => {
            const cleaned = (text || "")
                .toString()
                .replace(/\*\*/g, "")
                .replace(/\n+/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            if (!cleaned) return;

            const translated = translateKnownTutorText(cleaned);
            if (
                this.state.hintVisible &&
                !this.state.hintExiting &&
                this.state.hintMessage === translated
            ) {
                this._clearInlineHintTimers();
                this.state.hintTimestamp = normalizeTutorTimestamp(timestamp);
                this.state.hintHovered = false;
                this._scheduleInlineHintAutoHide();
                return;
            }

            this._clearInlineHintTimers();
            this.state.hintMessage = translated;
            this.state.hintTimestamp = normalizeTutorTimestamp(timestamp);
            this.state.hintHovered = false;
            this.state.hintExiting = false;
            this.state.hintCycle += 1;
            this.state.hintVisible = true;
            this._scheduleInlineHintAutoHide();
            // Use two animation frames so Owl renders the hint before measurement.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._syncHintScrollPadding());
            });
        };

        this._resetInlineHintState = ({ clearMessage = false } = {}) => {
            this._clearInlineHintTimers();
            this.state.hintVisible = false;
            this.state.hintExiting = false;
            this.state.hintHovered = false;
            if (clearMessage) {
                this.state.hintMessage = "";
                this.state.hintTimestamp = null;
            }
            this._syncHintScrollPadding();
        };

        this.closeInlineHint = () => {
            if (!this.state.hintVisible && !this.state.hintExiting) return;

            this._clearInlineHintTimers();

            if (this.state.hintExiting) return;

            this.state.hintExiting = true;
            this._syncHintScrollPadding();
            this._hintExitTimer = setTimeout(() => {
                this._resetInlineHintState();
            }, 180);
        };

        this.pauseInlineHint = () => {
            this.state.hintHovered = true;
            this._clearInlineHintTimers();
        };

        this.resumeInlineHint = () => {
            this.state.hintHovered = false;
            if (this.state.hintVisible && !this.state.hintExiting) {
                this._scheduleInlineHintAutoHide();
            }
        };

        this._clearInlineHintTimers = () => {
            if (this._hintAutoHideTimer) {
                clearTimeout(this._hintAutoHideTimer);
                this._hintAutoHideTimer = null;
            }
            if (this._hintExitTimer) {
                clearTimeout(this._hintExitTimer);
                this._hintExitTimer = null;
            }
        };

        this._scheduleInlineHintAutoHide = () => {
            if (this._hintAutoHideTimer) {
                clearTimeout(this._hintAutoHideTimer);
            }
            this._hintAutoHideTimer = setTimeout(() => {
                this._hintAutoHideTimer = null;
                if (!this.state.hintHovered) {
                    this.closeInlineHint();
                }
            }, INLINE_HINT_AUTO_HIDE_MS);
        };
        // Lifecycle
        onMounted(() => {
            this._setupHistoryListener();
            this._setupTutorPushListener();
            this._syncColorScheme();

            const el = this._getOffcanvasEl();
            if (el) {
                this._onShown = () => this._afterShown();
                this._onHidden = () => this._afterHidden();
                el.addEventListener("shown.bs.offcanvas", this._onShown);
                el.addEventListener("hidden.bs.offcanvas", this._onHidden);
            }

            this._loadRecorderPermission();
            this.state.breadcrumbPath = this._getCurrentBreadcrumbPath();

            this.contextInterval = setInterval(() => {
                this._syncColorScheme();

                const newContext = this.contextService.getContext();
                if (!newContext) return;

                if (!this.state.currentContext || JSON.stringify(newContext) !== JSON.stringify(this.state.currentContext)) {
                    this.state.currentContext = newContext;
                }

                const breadcrumbPath = this._getCurrentBreadcrumbPath();
                if (breadcrumbPath !== this.state.breadcrumbPath) {
                    this.state.breadcrumbPath = breadcrumbPath;
                    this._sendCurrentLiveContext();
                }
            }, 250);

            this.observer = new MutationObserver(() => this._scheduleChatLayoutSync());

            if (this.chatUiRef?.el) {
                this.observer.observe(this.chatUiRef.el, { childList: true, subtree: true });
            }

            this._recListener = (ev) => {
                this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
                if (!ev || ev.event_type !== "STEP_SAVED") return;

                const _id = ev._id || ev.step_id || ev.event_id || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
                if ((this.state.recorderFeed || []).some((x) => x?._id === _id)) return;

                this.state.recorderFeed = [{ ...ev, _id }, ...(this.state.recorderFeed || [])].slice(0, 60);
            };
            this.aiRecorder.subscribe(this._recListener);

            this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
            this._restoreActiveExerciseSession();

            this._onTutorHint = (ev) => {
                const msg = ev?.kind ? ev.data : ev;
                if (!msg || typeof msg !== "object") return;
                if (msg.type !== "tutor_hint") return;

                const text =
                    msg.message ||
                    msg.response ||
                    msg.content ||
                    msg.text ||
                    "";

                if (!text) return;

                this._setInlineHint(text, msg.timestamp);
            };

            if (!this._tutorHintSubscribed) {
                this.aiWs.subscribe(this._onTutorHint);
                this._tutorHintSubscribed = true;
            }

            this._onContextAck = (ev) => {
                const msg = ev?.kind ? ev.data : ev;
                if (!msg || typeof msg !== "object") return;
                if (msg.type !== "context_ack") return;
                if (
                    msg.mode === "awaiting_resume_confirmation" ||
                    msg.reason === "awaiting_resume_confirmation"
                ) {
                    this._restoreActiveExerciseSession();
                }
            };

            if (!this._contextAckSubscribed) {
                this.aiWs.subscribe(this._onContextAck);
                this._contextAckSubscribed = true;
            }

            this._onTutorHintEvent = (e) => {
                const data = e?.detail;
                if (!data) return;
                this._onTutorHint({ kind: "tutor_hint", data });
            };

            window.addEventListener("ai:tutor_hint", this._onTutorHintEvent);

            this._onExerciseChoiceEvent = (e) => {
                const detail = e?.detail || {};
                const action = detail.action === "cancel" ? "cancel" : "start";

                this._handleExerciseChoice({
                    exerciseId: detail.exerciseId || this.state.exerciseId,
                    answer: detail.answer || (action === "start" ? "Yes" : "No"),
                    action,
                });
            };

            window.addEventListener(EXERCISE_CHOICE_EVENT, this._onExerciseChoiceEvent);

            this._onExerciseSkipStepEvent = (e) => {
                const detail = e?.detail || {};
                const exerciseId = this._normalizeExerciseId(
                    detail.exerciseId || this.state.exerciseId
                );
                if (exerciseId) {
                    this.state.exerciseId = exerciseId;
                }
                this.onSkipStep();
            };

            window.addEventListener(EXERCISE_SKIP_STEP_EVENT, this._onExerciseSkipStepEvent);

            requestAnimationFrame(() => {
                this._startCopyButtonsObserver?.();
                this._installManualSelectionGuard?.();
                this._setupComposerOverflowTracking();
                this._syncComposerOverflowState();
                this._applyColorSchemeToChat();
                this._syncComposerDisabledState();
            });
        });

        onWillUnmount(() => {
            const el = this._getOffcanvasEl();
            if (el && this._onShown) el.removeEventListener("shown.bs.offcanvas", this._onShown);
            if (el && this._onHidden) el.removeEventListener("hidden.bs.offcanvas", this._onHidden);

            clearInterval(this.contextInterval);
            this._teardownTutorPushListener();
            this._teardownHistoryListener();
            this._resetInlineHintState({ clearMessage: true });

            if (this.observer) this.observer.disconnect();
            this.observer = null;

            if (this._chatLayoutSyncRaf) {
                cancelAnimationFrame(this._chatLayoutSyncRaf);
                this._chatLayoutSyncRaf = null;
            }
            if (this._conversationReadSyncTimer) {
                clearTimeout(this._conversationReadSyncTimer);
                this._conversationReadSyncTimer = null;
            }

            this._teardownAntiAutoScroll();
            this._teardownFeedbackObserver();

            document.body.classList.remove("o_ai_pick_mode");

            if (this._recListener) {
                this.aiRecorder.unsubscribe(this._recListener);
                this._recListener = null;
            }

            if (this._tutorPushSubscribed && this._onTutorPush) {
                this.aiWs.unsubscribe(this._onTutorPush);
                this._tutorPushSubscribed = false;
            }

            if (this._tutorHintSubscribed && this._onTutorHint) {
                this.aiWs.unsubscribe(this._onTutorHint);
                this._tutorHintSubscribed = false;
            }

            if (this._contextAckSubscribed && this._onContextAck) {
                this.aiWs.unsubscribe(this._onContextAck);
                this._contextAckSubscribed = false;
            }

            if (this._onTutorHintEvent) {
                window.removeEventListener("ai:tutor_hint", this._onTutorHintEvent);
                this._onTutorHintEvent = null;
            }

            if (this._onExerciseChoiceEvent) {
                window.removeEventListener(EXERCISE_CHOICE_EVENT, this._onExerciseChoiceEvent);
                this._onExerciseChoiceEvent = null;
            }

            if (this._onExerciseSkipStepEvent) {
                window.removeEventListener(EXERCISE_SKIP_STEP_EVENT, this._onExerciseSkipStepEvent);
                this._onExerciseSkipStepEvent = null;
            }

            if (this.state.timerInterval) {
                clearInterval(this.state.timerInterval);
                this.state.timerInterval = null;
            }

            this._seenTutorPushIds = null;

            if (this._copyButtonsObserver) {
                this._copyButtonsObserver.disconnect();
                this._copyButtonsObserver = null;
            }

            this._removeManualSelectionGuard?.();
            this._teardownComposerOverflowTracking();
        });

        this.onHandleMouseDown = useMouseListeners({
            onMouseDown: this.onMouseDown,
            onMouseMove: this.onMouseMove,
            onMouseUp: this.onMouseUp,
        });
    }
    // COPY BUTTON HELPERS
    _getChatContainer() {
        return this.containerRef.el?.querySelector?.("#chat-ui-container") || document.querySelector("#chat-ui-container");
    }

    _getMessageItems() {
        const container = this._getChatContainer();
        if (!container) return [];
        return Array.from(
            container.querySelectorAll(".nlux-comp-chatItem--received, .nlux-comp-chatItem--sent")
        );
    }

    _getMessageHost(itemEl) {
        if (!itemEl) return null;

        return (
            itemEl.querySelector(".nlux-comp-message") ||
            itemEl.querySelector(".nlux-comp-bubble") ||
            itemEl.querySelector('[class*="comp-message"]') ||
            itemEl.querySelector('[class*="bubble"]') ||
            null
        );
    }

    _getMessageTextBlock(messageHost) {
        if (!messageHost) return null;

        return (
            messageHost.querySelector(".nlux-markdown-container") ||
            messageHost.querySelector(".nlux-comp-messageContent") ||
            messageHost.querySelector(".nlux-comp-messageText") ||
            messageHost.querySelector('[class*="messageContent"]') ||
            messageHost.querySelector('[class*="messageText"]') ||
            messageHost.querySelector('[class*="markdown"]') ||
            messageHost.firstElementChild ||
            null
        );
    }

    _findFooterRow(messageHost) {
        if (!messageHost) return null;
        return messageHost.querySelector(".ai-msg-footer");
    }

    _ensureFooterRow(messageHost, itemEl) {
        const textBlock = this._getMessageTextBlock(messageHost);
        if (!textBlock) return null;

        let footer = this._findFooterRow(messageHost);
        if (footer) {
            if (footer.nextElementSibling !== textBlock) {
                textBlock.insertAdjacentElement("beforebegin", footer);
            }
            return footer;
        }

        footer = document.createElement("div");
        footer.className = "ai-msg-footer";
        textBlock.insertAdjacentElement("beforebegin", footer);

        return footer;
    }

    _findExistingFeedbackRows(messageHost) {
        if (!messageHost) return [];
        return Array.from(
            messageHost.querySelectorAll(
                ".nlux-comp-messageFeedback, .nlux-comp-chatItem-actions, .nlux-comp-message-actions"
            )
        );
    }

    _findExistingFeedbackButtons(messageHost) {
        const rows = this._findExistingFeedbackRows(messageHost);
        if (!rows.length) return [];

        return rows.flatMap((row) =>
            Array.from(row.querySelectorAll("button")).filter((btn) => !btn.classList.contains("ai-copy-btn"))
        );
    }

    _moveFeedbackButtonsToFooter(messageHost, footer) {
        return;
    }

    _findCommentButton(containerEl) {
        if (!containerEl) return null;

        const buttons = Array.from(containerEl.querySelectorAll("button"));
        return buttons.find((btn) => {
            const title = (btn.getAttribute("title") || "").toLowerCase();
            const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
            const dataAct = (btn.dataset.act || "").toLowerCase();
            const html = (btn.innerHTML || "").toLowerCase();

            return (
                title.includes("comment") ||
                aria.includes("comment") ||
                dataAct === "comment" ||
                html.includes("fa-comment")
            );
        }) || null;
    }

    _getCopyTextFromItem(itemEl) {
        const messageHost = this._getMessageHost(itemEl);
        const textBlock = this._getMessageTextBlock(messageHost);

        return (
            textBlock?.innerText ||
            textBlock?.textContent ||
            messageHost?.innerText ||
            ""
        ).trim();
    }

    _buildCopyButton(itemEl) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ai-msg-action ai-copy-btn";
        btn.setAttribute("aria-label", "Copy message");
        btn.setAttribute("title", "Copy");
        btn.setAttribute("data-original-title", "Copy");
        btn.setAttribute("data-copy-icon", this._copySvg());
        btn.setAttribute("data-check-icon", this._checkSvg());

        btn.innerHTML = btn.getAttribute("data-copy-icon");

        btn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            const text = this._getCopyTextFromItem(itemEl);
            if (!text) return;

            const copied = await this._copyTextToClipboard(text);
            this._flashCopyButton(btn, copied);
        });

        return btn;
    }

    _insertCopyButton(actionsRow, copyBtn) {
        if (!actionsRow || !copyBtn) return;
        actionsRow.insertAdjacentElement("afterbegin", copyBtn);
    }

    _syncMessageSequenceClasses(items = null) {
        const messageItems = items || this._getMessageItems();
        if (!messageItems.length) return;

        messageItems.forEach((itemEl, index) => {
            itemEl.classList.remove("ai-received-run-start");

            if (!itemEl.classList.contains("nlux-comp-chatItem--received")) {
                return;
            }

            const prevItem = messageItems[index - 1];
            const nextItem = messageItems[index + 1];
            const prevIsReceived = !!prevItem?.classList?.contains("nlux-comp-chatItem--received");
            const nextIsReceived = !!nextItem?.classList?.contains("nlux-comp-chatItem--received");

            if (!prevIsReceived && nextIsReceived) {
                itemEl.classList.add("ai-received-run-start");
            }
        });
    }

    _ensureCopyButtons() {
        const items = this._getMessageItems();
        if (!items.length) return;

        this._syncMessageSequenceClasses(items);

        items.forEach((itemEl) => {
            const messageHost = this._getMessageHost(itemEl);
            if (!messageHost) return;

            const footer = this._ensureFooterRow(messageHost, itemEl);
            if (!footer) return;

            this._moveFeedbackButtonsToFooter(messageHost, footer);

            if (!footer.querySelector(".ai-copy-btn")) {
                const copyBtn = this._buildCopyButton(itemEl);
                this._insertCopyButton(footer, copyBtn);
            }
        });

        this._highlightCopyTargets(items);
    }
    // COPY-TARGET HIGHLIGHTING (clickable values inside instructions)
    _registerCopyTargets(displayText, copyTargets) {
        if (!Array.isArray(copyTargets) || !copyTargets.length) return;

        const key = normalizeForCopyTargetLookup(displayText);
        if (!key) return;

        const registry = getCopyTargetsRegistry();
        registry.set(key, copyTargets);

        while (registry.size > COPY_TARGETS_REGISTRY_MAX_SIZE) {
            const oldestKey = registry.keys().next().value;
            registry.delete(oldestKey);
        }
    }

    _prepareAssistantDisplayText(rawText, copyTargets) {
        const cleaned = String(rawText || "").trim();
        if (!cleaned) return "";

        const displayText = stripNewlinesAroundCopyTargets(
            translateKnownTutorText(cleaned),
            copyTargets
        );
        this._registerCopyTargets(displayText, copyTargets);
        return displayText;
    }

    _highlightCopyTargets(items) {
        const registry = getCopyTargetsRegistry();
        if (!registry.size) return;

        items.forEach((itemEl) => {
            if (!itemEl.classList.contains("nlux-comp-chatItem--received")) return;

            const messageHost = this._getMessageHost(itemEl);
            const textBlock = this._getMessageTextBlock(messageHost);
            if (!textBlock || textBlock.dataset.copyHighlighted === "1") return;

            const key = normalizeForCopyTargetLookup(textBlock.textContent || "");
            const targets = registry.get(key);

            textBlock.dataset.copyHighlighted = "1";
            if (targets?.length) {
                this._wrapCopyTargetsInElement(textBlock, targets);
            }
        });
    }

    _wrapCopyTargetsInElement(rootEl, targets) {
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) =>
                node.parentElement?.closest(".ai-copy-value")
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT,
        });

        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }

        textNodes.forEach((textNode) => {
            this._replaceTextNodeWithCopySegments(textNode, targets);
        });
    }

    _replaceTextNodeWithCopySegments(textNode, targets) {
        const raw = textNode.textContent;
        if (!raw) return;

        const segments = buildCopySegments(raw, targets);
        if (segments.length === 1 && !segments[0].isCopy) return;

        const parent = textNode.parentNode;
        if (!parent) return;

        const fragment = document.createDocumentFragment();
        segments.forEach((seg) => {
            if (seg.isCopy) {
                fragment.appendChild(this._buildCopyValueSpan(seg));
            } else if (seg.text) {
                fragment.appendChild(document.createTextNode(seg.text));
            }
        });

        parent.replaceChild(fragment, textNode);
    }

    _buildCopyValueSpan(segment) {
        const span = document.createElement("span");
        span.className = "ai-copy-value";
        span.textContent = segment.text;
        span.setAttribute("role", "button");
        span.setAttribute("tabindex", "0");
        span.setAttribute("title", segment.copyLabel);
        span.setAttribute("aria-label", segment.copyLabel);

        const doCopy = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            const copied = await this._copyTextToClipboard(segment.text);
            this._flashCopyValueSpan(span, copied, segment.copyLabel);
        };

        span.addEventListener("click", doCopy);
        span.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") doCopy(ev);
        });

        return span;
    }

    _flashCopyValueSpan(span, copied, originalLabel) {
        if (!span) return;

        clearTimeout(span.__copyResetTimer);
        span.classList.remove("is-copied", "is-copy-failed");

        const flashLabel = copied ? _t("Copied!") : _t("Copy failed");
        span.classList.add(copied ? "is-copied" : "is-copy-failed");
        span.setAttribute("title", flashLabel);
        span.setAttribute("aria-label", flashLabel);

        span.__copyResetTimer = setTimeout(() => {
            span.classList.remove("is-copied", "is-copy-failed");
            span.setAttribute("title", originalLabel);
            span.setAttribute("aria-label", originalLabel);
        }, 1500);
    }

    _startCopyButtonsObserver() {
        const container = this._getChatContainer();
        if (!container) return;

        this._ensureCopyButtons();

        if (this._copyButtonsObserver) {
            this._copyButtonsObserver.disconnect();
        }

        this._copyButtonsObserver = new MutationObserver(() => {
            this._ensureCopyButtons();
        });

        this._copyButtonsObserver.observe(container, {
            childList: true,
            subtree: true,
        });
    }

    _hasManualSelection() {
        const sel = window.getSelection?.();
        if (!sel) return false;
        return !sel.isCollapsed && !!String(sel).trim();
    }

    _isSelectableMessageTarget(target) {
        if (!target?.closest) return false;

        return !!target.closest(
            ".nlux-markdown-container, " +
            ".nlux-comp-messageContent, " +
            ".nlux-comp-messageText, " +
            ".nlux-comp-message, " +
            ".ai-inline-hint-text, " +
            ".ai_push_body"
        );
    }

    _isNonSelectableActionTarget(target) {
        if (!target?.closest) return false;

        return !!target.closest(
            "button, a, input, textarea, select, label, " +
            ".ai-msg-footer, .ai_feedback_bar, .ai_feedback_popover, " +
            ".ai-copy-btn, .ai_feedback_btn, .ai-exercise-actions, .ai-copy-value"
        );
    }

    _installManualSelectionGuard() {
        const root = this._getChatContainer() || this.chatUiRef?.el;
        if (!root || this._manualSelectionGuardInstalled) return;

        this._onSelectionMouseDown = (ev) => {
            if (this._isNonSelectableActionTarget(ev.target)) return;
            if (!this._isSelectableMessageTarget(ev.target)) return;

            this._manualSelecting = true;
            ev.stopPropagation();
        };

        this._onSelectionMouseUp = (ev) => {
            if (!this._manualSelecting) return;

            ev.stopPropagation();

            setTimeout(() => {
                if (this._hasManualSelection()) {
                    this._setComposerAutoFocus(false);

                    const active = document.activeElement;
                    if (active?.closest?.(".nlux-composer-container")) {
                        active.blur();
                    }
                }
                this._manualSelecting = false;
            }, 0);
        };

        this._onSelectionClick = (ev) => {
            if (this._isNonSelectableActionTarget(ev.target)) return;
            if (!this._isSelectableMessageTarget(ev.target)) return;

            if (this._hasManualSelection()) {
                ev.stopPropagation();
            }
        };

        root.addEventListener("mousedown", this._onSelectionMouseDown, true);
        root.addEventListener("mouseup", this._onSelectionMouseUp, true);
        root.addEventListener("click", this._onSelectionClick, true);

        this._manualSelectionGuardInstalled = true;
    }

    _removeManualSelectionGuard() {
        const root = this._getChatContainer() || this.chatUiRef?.el;
        if (!root || !this._manualSelectionGuardInstalled) return;

        if (this._onSelectionMouseDown) {
            root.removeEventListener("mousedown", this._onSelectionMouseDown, true);
        }
        if (this._onSelectionMouseUp) {
            root.removeEventListener("mouseup", this._onSelectionMouseUp, true);
        }
        if (this._onSelectionClick) {
            root.removeEventListener("click", this._onSelectionClick, true);
        }

        this._onSelectionMouseDown = null;
        this._onSelectionMouseUp = null;
        this._onSelectionClick = null;
        this._manualSelectionGuardInstalled = false;
        this._manualSelecting = false;
    }

    get hintTimeAgo() {
        return formatTimeAgo(this.state.hintTimestamp);
    }

    get unreadCount() {
        return this.aiChatStore?.state?.unreadCount || 0;
    }

    get showUnreadIndicator() {
        return (
            !this.state.showRecorderPanel &&
            this.unreadCount > 0 &&
            !this.aiChatStore?.state?.isAtBottom
        );
    }

    get unreadIndicatorLabel() {
        return this.unreadCount > 1 ? _t("%s new messages", this.unreadCount) : _t("New message");
    }

    get wsStatusLabel() {
        const status = String(this.state.wsStatus || "unknown").toLowerCase();
        const labels = {
            online: _t("online"),
            offline: _t("offline"),
            unknown: _t("unknown"),
        };
        return labels[status] || this.state.wsStatus || labels.unknown;
    }

    translate(text) {
        return _t(text);
    }

    jumpToNewestMessage() {
        this._scrollConversationToBottom({ smooth: true });
        this.aiChatStore?.markRead?.();
        this.aiChatStore?.setAtBottom?.(true);
    }

    get currentRouteLabel() {
        return this.state.breadcrumbPath || this.currentContextLabel || "";
    }

    _getLiveContextRoute() {
        return this.state.breadcrumbPath || this._getCurrentBreadcrumbPath() || this.currentContextLabel || "";
    }

    _sendCurrentLiveContext({ force = false } = {}) {
        const ctx = this.state.currentContext;
        if (!ctx?.model) return;
        try {
            this.aiWs?.sendLiveContext?.({
                context_model: ctx.model,
                route: this._getLiveContextRoute(),
                force,
            });
        } catch (_) {}
    }

    get currentContextLabel() {
        const model = this.state.currentContext?.model;
        if (!model) return "";

        const modelLabels = {
            "sale.order": _t("Sales"),
            "account.move": _t("Accounting"),
            "project.task": _t("Project Tasks"),
        };

        if (modelLabels[model]) return modelLabels[model];

        return model
            .split(".")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" / ");
    }

    _getCurrentBreadcrumbPath() {
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
        if (currentLabel) {
            parts.push(currentLabel);
        }

        return parts
            .filter((part, index, allParts) => part && part !== "..." && allParts[index - 1] !== part)
            .join(" / ");
    }

    _copySvg() {
        return `
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z"/>
            </svg>
        `;
    }

    _checkSvg() {
        return `
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                    fill="currentColor"
                    d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
                />
            </svg>
        `;
    }

    async _copyTextToClipboard(text) {
        const value = (text || "").trim();
        if (!value) return false;

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
                return true;
            }
        } catch {}

        try {
            const ta = document.createElement("textarea");
            ta.value = value;
            ta.setAttribute("readonly", "readonly");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            ta.style.pointerEvents = "none";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return !!ok;
        } catch {
            return false;
        }
    }

    _flashCopyButton(btn, copied) {
        if (!btn) return;

        const originalTitle = btn.getAttribute("data-original-title") || "Copy";
        const copyIcon = btn.getAttribute("data-copy-icon") || this._copySvg();
        const checkIcon = btn.getAttribute("data-check-icon") || this._checkSvg();

        btn.classList.remove("is-copied", "is-copy-failed");
        clearTimeout(btn.__copyResetTimer);

        if (copied) {
            btn.classList.add("is-copied");
            btn.setAttribute("title", "Copied");
            btn.setAttribute("aria-label", "Copied");
            btn.innerHTML = checkIcon;
        } else {
            btn.classList.add("is-copy-failed");
            btn.setAttribute("title", "Copy failed");
            btn.setAttribute("aria-label", "Copy failed");
            btn.innerHTML = copyIcon;
        }

        btn.__copyResetTimer = setTimeout(() => {
            btn.classList.remove("is-copied", "is-copy-failed");
            btn.setAttribute("title", originalTitle);
            btn.setAttribute("aria-label", originalTitle);
            btn.innerHTML = copyIcon;
        }, copied ? 1400 : 1200);
    }
    // Helpers for tutor_push
    _escapeHtml(s) {
        return String(s)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    _getRecentAssistantTextsFromDom(limit = 10) {
        const root = this.chatUiRef?.el;
        if (!root) return [];

        const items = Array.from(
            root.querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received .nlux-markdown-container")
        );

        return items
            .slice(-limit)
            .map((el) => normalizeAssistantTextForCompare(el?.innerText || el?.textContent || ""))
            .filter(Boolean);
    }

    _isDuplicateAssistantText(text) {
        const normalized = normalizeAssistantTextForCompare(text);
        if (!normalized) return true;

        const now = Date.now();
        const lastInjectedNormalized = normalizeAssistantTextForCompare(this._lastInjectedTutorText || "");

        if (
            lastInjectedNormalized === normalized &&
            now - this._lastInjectedTutorAt < 6000
        ) {
            return true;
        }

        const recentDomTexts = this._getRecentAssistantTextsFromDom?.(12) || [];
        if (recentDomTexts.includes(normalized)) {
            return true;
        }

        return false;
    }

    _ensureConversationVisible() {
        const root = this.chatUiRef?.el;
        if (!root) return;

        const chatRoom = root.querySelector(".nlux-chatRoom-container");
        if (chatRoom?.classList?.contains("nlux-chatRoom-starting")) {
            chatRoom.classList.remove("nlux-chatRoom-starting");
        }
    }

    _injectAssistantToNlux(text) {
        const root = this.chatUiRef?.el;
        if (!root) return;

        this._ensureConversationVisible();

        const segments = root.querySelector(".nlux-chatSegments-container");
        if (!segments) {
            console.warn("[AiSidebar] NLUX segments container not found yet");
            return;
        }

        const item = this._buildManualReceivedItem(text);

        segments.appendChild(item);

        try {
            this._anchorEl = item;
            this._startLockToAnchor();
        } catch (_) {}

        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }

    _buildManualReceivedItem(text) {
        const item = document.createElement("div");
        item.className = "nlux-comp-chatItem nlux-comp-chatItem--received nlux-comp-chatItem--bubblesLayout";
        item.innerHTML = `<div class="nlux-comp-chatItem-participantInfo"><div class="nlux-comp-avatar"><div class="nlux-comp-avatarContainer"><div class="nlux-comp-avatarPicture" style="background-image: url('${TUTOR_ASSISTANT_AVATAR_URL}')"></div></div></div></div><div class="nlux-comp-message"><div class="nlux-markdown-container">${this._escapeHtml(text).replace(/\n/g, "<br/>")}</div></div>`;
        return item;
    }

    _normalizeExerciseId(value) {
        if (value === null || value === undefined || value === false) return null;
        if (typeof value !== "string" && typeof value !== "number") return null;
        if (typeof value === "number" && !Number.isFinite(value)) return null;
        const normalized = String(value).trim();
        const lowered = normalized.toLowerCase();
        if (!normalized || normalized === "0") return null;
        if (["false", "null", "undefined", "none", "nan"].includes(lowered)) return null;
        if (/^0+$/.test(normalized.replace(/[-_]/g, ""))) return null;
        return normalized;
    }

    _extractExerciseId(payload) {
        if (!payload || typeof payload !== "object") return null;

        const candidates = [
            payload.exercise_id,
            payload.exerciseId,
            payload.result?.exercise_id,
            payload.result?.exerciseId,
            payload.data?.exercise_id,
            payload.data?.exerciseId,
            payload.payload?.exercise_id,
            payload.payload?.exerciseId,
            payload.cta_metadata?.exercise_id,
            payload.cta_metadata?.exerciseId,
            payload.ctaMetadata?.exercise_id,
            payload.ctaMetadata?.exerciseId,
            payload.result?.cta_metadata?.exercise_id,
            payload.result?.cta_metadata?.exerciseId,
            payload.data?.cta_metadata?.exercise_id,
            payload.data?.cta_metadata?.exerciseId,
            payload.payload?.cta_metadata?.exercise_id,
            payload.payload?.cta_metadata?.exerciseId,
            payload.exercise?.id,
        ];

        for (const candidate of candidates) {
            const exerciseId = this._normalizeExerciseId(candidate);
            if (exerciseId) return exerciseId;
        }

        return null;
    }

    _extractResponseText(payload) {
        if (!payload) return "";
        if (typeof payload === "string") return payload.trim();
        if (typeof payload !== "object") return "";

        return String(
            payload.response ||
            payload.message ||
            payload.content ||
            payload.text ||
            (typeof payload.result === "string" ? payload.result : "") ||
            payload.result?.response ||
            payload.result?.message ||
            payload.result?.content ||
            payload.data?.response ||
            payload.data?.message ||
            payload.data?.content ||
            ""
        ).trim();
    }

    _extractCopyTargets(payload) {
        if (!payload || typeof payload !== "object") return [];

        const candidates = [
            payload.copy_targets,
            payload.result?.copy_targets,
            payload.data?.copy_targets,
            payload.raw?.copy_targets,
        ];

        return candidates.find((value) => Array.isArray(value)) || [];
    }

    _isWelcomePromptPayload(payload) {
        if (!payload || typeof payload !== "object") return false;

        if (payload.type === "welcome_push") return true;

        const candidates = [
            payload.is_welcome,
            payload.isWelcome,
            payload.result?.is_welcome,
            payload.result?.isWelcome,
            payload.data?.is_welcome,
            payload.data?.isWelcome,
            payload.payload?.is_welcome,
            payload.payload?.isWelcome,
        ];

        return candidates.some((value) => {
            if (value === true || value === 1) return true;
            if (typeof value === "string") {
                return ["true", "1", "yes"].includes(value.trim().toLowerCase());
            }
            return false;
        });
    }

    _isExerciseCompletedPayload(payload) {
        if (!payload) return false;

        if (typeof payload === "object" && payload.type === "exercise_completed_push") {
            return true;
        }

        const responseText = this._extractResponseText(payload);
        const candidates = [];

        if (typeof payload === "string") {
            candidates.push(payload);
        } else if (typeof payload === "object") {
            candidates.push(
                payload.status,
                payload.exercise_status,
                payload.exerciseStatus,
                payload.event,
                payload.event_name,
                payload.result?.status,
                payload.result?.exercise_status,
                payload.result?.exerciseStatus,
                payload.data?.status,
                payload.data?.exercise_status,
                payload.data?.exerciseStatus,
                payload.payload?.status,
                payload.payload?.exercise_status,
                payload.payload?.exerciseStatus,
                responseText
            );
        }

        return candidates.some((value) => {
            const normalized = normalizeAssistantTextForCompare(value || "").replace(/[\s-]+/g, "_");
            return (
                normalized === "exercise_completed" ||
                normalized === "completed" ||
                normalized.includes("exercise_completed") ||
                normalized.includes("exercise_completado") ||
                normalized.includes("ejercicio_completado")
            );
        });
    }

    _isExerciseResumePromptText(text) {
        const normalized = String(text || "").toLowerCase();
        return (
            normalized.includes("do you want to continue the exercise") ||
            normalized.includes("quieres continuar el ejercicio") ||
            normalized.includes("deseas continuar el ejercicio") ||
            normalized.includes("continuar el ejercicio") ||
            normalized.includes("yes / later / cancel") ||
            normalized.includes("yes/later/cancel")
        );
    }

    _getPromptExerciseId(exerciseId, options = {}) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        if (!normalizedExerciseId) return null;
        if (this.state.processActive && !options.allowWhileActive) return null;
        return normalizedExerciseId;
    }

    _publishExerciseCtaState({ exerciseId = this.state.exerciseId, status = this.state.exerciseCtaStatus } = {}) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        const visible = !!normalizedExerciseId && !!this.state.exerciseChoicePending;
        const payload = {
            exerciseId: visible ? normalizedExerciseId : null,
            visible,
            status: visible ? String(status || "") : "",
            updatedAt: Date.now(),
        };

        this.state.exerciseCtaStatus = payload.status;
        Object.assign(getExerciseCtaState(), payload);
        window.dispatchEvent(new CustomEvent(EXERCISE_CTA_EVENT, { detail: payload }));
    }

    _clearExerciseCtaState() {
        const payload = {
            exerciseId: null,
            visible: false,
            status: "",
            updatedAt: Date.now(),
        };

        this.state.exerciseCtaStatus = "";
        Object.assign(getExerciseCtaState(), payload);
        window.dispatchEvent(new CustomEvent(EXERCISE_CTA_EVENT, { detail: payload }));
    }

    _registerExercisePrompt(exerciseId, options = {}) {
        const normalizedExerciseId = this._getPromptExerciseId(exerciseId, options);
        if (!normalizedExerciseId) {
            this._cancelPendingExerciseActions();
            return null;
        }
        this.state.exerciseId = normalizedExerciseId;
        this.state.showButtons = true;
        this.state.exerciseChoicePending = true;
        this.state.exerciseCtaStatus = "";
        this._syncComposerDisabledState();
        this._publishExerciseCtaState({ exerciseId: normalizedExerciseId });
        return normalizedExerciseId;
    }

    _cancelPendingExerciseActions() {
        const hadPendingCta = this.state.exerciseChoicePending || !!getExerciseCtaState().visible;
        this._exerciseActionsScheduleVersion += 1;
        this.state.exerciseChoicePending = false;
        if (hadPendingCta) {
            this._clearExerciseCtaState();
        }
        this._syncComposerDisabledState();
    }

    _syncComposerDisabledState() {
        const disabled = !!this.state.exerciseChoicePending;
        const container = this._getChatContainer();
        const root = this.chatUiRef?.el || container;

        container?.classList?.toggle("is-exercise-input-locked", disabled);

        const inputs = root?.querySelectorAll?.(
            ".nlux-composer-container textarea, " +
            ".nlux-composer-container input, " +
            ".nlux-comp-composer textarea, " +
            ".nlux-comp-composer input"
        ) || [];

        inputs.forEach((input) => {
            input.disabled = disabled;
            input.readOnly = disabled;
            input.setAttribute("aria-disabled", disabled ? "true" : "false");
            if (disabled) input.blur();
        });

        const buttons = root?.querySelectorAll?.(
            ".nlux-composer-container button, " +
            ".nlux-comp-composer button"
        ) || [];

        buttons.forEach((button) => {
            button.disabled = disabled;
            button.setAttribute("aria-disabled", disabled ? "true" : "false");
        });
    }

    _getLatestReceivedMessageItem() {
        const root = this.chatUiRef?.el;
        if (!root) return null;

        const items = Array.from(
            root.querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received")
        );
        return items[items.length - 1] || null;
    }

    _getReceivedMessageCount() {
        const root = this.chatUiRef?.el;
        if (!root) return 0;
        return root.querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received").length;
    }

    _scheduleExerciseActionsForLastMessage(
        exerciseId,
        attempts = 80,
        minReceivedCount = 0,
        scheduleVersion = null,
        options = {}
    ) {
        const normalizedExerciseId = this._getPromptExerciseId(exerciseId, options);
        if (!normalizedExerciseId || attempts <= 0) return;

        const version = scheduleVersion || ++this._exerciseActionsScheduleVersion;

        requestAnimationFrame(() => {
            if (version !== this._exerciseActionsScheduleVersion) return;
            if (this.state.processActive && !options.allowWhileActive) return;

            const receivedItems = Array.from(
                this.chatUiRef?.el?.querySelectorAll(
                    ".nlux-comp-chatItem.nlux-comp-chatItem--received"
                ) || []
            );
            const receivedCount = receivedItems.length;
            const targetIndex = minReceivedCount > 0 ? minReceivedCount - 1 : receivedCount - 1;
            const item = targetIndex >= 0 ? receivedItems[targetIndex] : null;
            if (item) {
                if (item.querySelector(".ai-exercise-actions")) return;
                if (this._attachExerciseActions(item, normalizedExerciseId, options)) return;
            }
            if (attempts > 1) {
                window.setTimeout(
                    () => this._scheduleExerciseActionsForLastMessage(
                        normalizedExerciseId,
                        attempts - 1,
                        minReceivedCount,
                        version,
                        options
                    ),
                    40
                );
            }
        });
    }

    _attachExerciseActions(itemEl, exerciseId, options = {}) {
        const normalizedExerciseId = this._getPromptExerciseId(exerciseId, options);
        if (!itemEl || !normalizedExerciseId) return false;
        if (itemEl.querySelector(".ai-exercise-actions")) return true;

        const messageHost = this._getMessageHost(itemEl);
        const textBlock = this._getMessageTextBlock(messageHost);
        if (!messageHost || !textBlock) return false;

        itemEl.dataset.exerciseId = normalizedExerciseId;
        this._trimMessageBlockEnd(textBlock);

        const actions = document.createElement("div");
        actions.className = "ai-exercise-actions";
        actions.dataset.exerciseId = normalizedExerciseId;
        actions.innerHTML = `
            <div class="ai-exercise-actions-buttons">
                <button
                    type="button"
                    class="ai-exercise-choice ai-exercise-choice-yes"
                    data-action="start"
                    aria-label="${this._escapeHtml(_t("Start this exercise"))}"
                >
                    ${this._escapeHtml(_t("Yes"))}
                </button>
                <button
                    type="button"
                    class="ai-exercise-choice ai-exercise-choice-cancel"
                    data-action="cancel"
                    aria-label="${this._escapeHtml(_t("No, not now"))}"
                >
                    ${this._escapeHtml(_t("No"))}
                </button>
            </div>
        `;

        const yesBtn = actions.querySelector('[data-action="start"]');
        const cancelBtn = actions.querySelector('[data-action="cancel"]');

        yesBtn?.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._handleExerciseChoice({
                exerciseId: normalizedExerciseId,
                answer: "Yes",
                action: "start",
                card: actions,
            });
        });

        cancelBtn?.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._handleExerciseChoice({
                exerciseId: normalizedExerciseId,
                answer: "No",
                action: "cancel",
                card: actions,
            });
        });

        textBlock.appendChild(actions);
        return true;
    }

    _trimMessageBlockEnd(textBlock) {
        if (!textBlock) return;

        while (textBlock.lastChild) {
            const node = textBlock.lastChild;

            if (node.nodeType === Node.TEXT_NODE) {
                const trimmed = node.textContent.replace(/\s+$/g, "");
                if (trimmed) {
                    node.textContent = trimmed;
                    break;
                }
                node.remove();
                continue;
            }

            if (
                node.nodeType === Node.ELEMENT_NODE &&
                (node.tagName === "BR" || !String(node.textContent || "").trim())
            ) {
                node.remove();
                continue;
            }

            break;
        }
    }

    _setExerciseActionsState(card, status) {
        if (!card) return;

        card.dataset.status = status || "";
        card.querySelectorAll("button").forEach((btn) => {
            btn.disabled = status === "sending" || status === "accepted" || status === "cancelled";
        });
    }

    _setExerciseActionsStateForExercise(exerciseId, status, card = null) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        const cards = new Set(card ? [card] : []);

        this._getChatContainer()
            ?.querySelectorAll?.(".ai-exercise-actions")
            ?.forEach((candidate) => {
                if (
                    this._normalizeExerciseId(candidate.dataset.exerciseId) ===
                    normalizedExerciseId
                ) {
                    cards.add(candidate);
                }
            });

        cards.forEach((candidate) => this._setExerciseActionsState(candidate, status));
    }

    async _sendExerciseChoiceToWs({ exerciseId, answer, action }) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        if (!normalizedExerciseId) return null;

        const context = {
            ...(this.state.currentContext || {}),
            exercise_id: normalizedExerciseId,
            exercise_action: action,
        };

        return await this.aiWs.chat({
            message: answer,
            context,
            payloadExtra: {
                exercise_id: normalizedExerciseId,
                exercise_action: action,
            },
        });
    }

    async _handleExerciseChoice({ exerciseId, answer, action, card }) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        if (
            !normalizedExerciseId ||
            card?.dataset?.status === "sending" ||
            this.state.exerciseCtaStatus === "sending"
        ) {
            return;
        }

        this._publishExerciseCtaState({
            exerciseId: normalizedExerciseId,
            status: "sending",
        });

        this._setExerciseActionsStateForExercise(normalizedExerciseId, "sending", card);

        if (action === "start") {
            const wasProcessActive = !!this.state.processActive;
            this.state.exerciseChoicePending = false;
            this._syncComposerDisabledState();
            if (wasProcessActive) {
                this.state.exerciseId = normalizedExerciseId;
                this.state.showButtons = false;
                this._clearExerciseCtaState();
                if (this.state.timerPaused) {
                    this._resumeExerciseTimer({ exerciseId: normalizedExerciseId });
                } else {
                    this._persistActiveExercise({
                        exerciseId: normalizedExerciseId,
                        startedAt: Date.now() - (this.state.timerSeconds || 0) * 1000,
                        paused: false,
                        elapsedSeconds: this.state.timerSeconds,
                    });
                }
            } else {
                this.startProcess(normalizedExerciseId);
            }
        } else {
            this.cancelProcess();
        }

        try {
            const response = await this._sendExerciseChoiceToWs({ exerciseId: normalizedExerciseId, answer, action });
            const responseText = this._prepareAssistantDisplayText(
                this._extractResponseText(response),
                this._extractCopyTargets(response)
            );

            if (responseText && !this._isDuplicateAssistantText(responseText)) {
                // Queue the response while the sidebar is closed to preserve chat order.
                if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                    this._queueTutorMessage(responseText, response?.raw?.timestamp || response?.timestamp, {
                        exerciseId: response?.raw?.exercise_id || normalizedExerciseId,
                    });
                } else {
                    this._pushAssistantMessageToNlux(responseText);
                }
            }

            this._setExerciseActionsStateForExercise(
                normalizedExerciseId,
                action === "start" ? "accepted" : "cancelled",
                card
            );
        } catch (e) {
            console.warn("[AiSidebar] exercise choice failed:", e);
            this._setExerciseActionsStateForExercise(normalizedExerciseId, "error", card);
            this.notification.add(_t("Could not send the exercise answer to WebSocket."), { type: "danger" });
        }
    }

    async onTimerCancelExercise() {
        if (!this.state.processActive || this.state.exerciseCancelLoading) return;

        const normalizedExerciseId = this._normalizeExerciseId(this.state.exerciseId);
        if (!normalizedExerciseId) {
            this.cancelProcess();
            return;
        }

        this.state.exerciseCancelLoading = true;
        try {
            const response = await this._sendExerciseChoiceToWs({
                exerciseId: normalizedExerciseId,
                answer: "No",
                action: "cancel",
            });
            const responseText = this._prepareAssistantDisplayText(
                this._extractResponseText(response),
                this._extractCopyTargets(response)
            );
            this.cancelProcess();

            if (responseText && !this._isDuplicateAssistantText(responseText)) {
                // Queue the response while the sidebar is closed to preserve chat order.
                if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                    this._queueTutorMessage(responseText, response?.raw?.timestamp || response?.timestamp, {
                        exerciseId: response?.raw?.exercise_id || normalizedExerciseId,
                    });
                } else {
                    const inserted = this._pushAssistantMessageToNlux(responseText);
                    if (inserted) {
                        this._lastInjectedTutorText = responseText;
                        this._lastInjectedTutorAt = Date.now();
                    }
                }
            }
        } catch (e) {
            console.warn("[AiSidebar] timer cancel failed:", e);
            this.notification.add(_t("Could not cancel the exercise through WebSocket."), { type: "danger" });
        } finally {
            this.state.exerciseCancelLoading = false;
        }
    }

    async onSkipStep() {
        if (
            !this.state.skipStepEnabled ||
            !this.state.processActive ||
            this.state.skipStepLoading
        ) {
            return;
        }

        const exerciseId = this._normalizeExerciseId(this.state.exerciseId);
        if (!exerciseId) return;

        this.state.skipStepLoading = true;
        try {
            const response = await this.aiWs.chat(
                buildSkipStepRequest({
                    exerciseId,
                    context: this.state.currentContext || {},
                })
            );
            const responseText = getVisibleSkipResponse(
                response,
                (payload) =>
                    this._prepareAssistantDisplayText(
                        this._extractResponseText(payload),
                        this._extractCopyTargets(payload)
                    ),
                (text) => this._isDuplicateAssistantText(text)
            );
            if (responseText) {
                // Queue the response while the sidebar is closed to preserve chat order.
                if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                    this._queueTutorMessage(responseText, response?.raw?.timestamp || response?.timestamp, {
                        exerciseId: response?.raw?.exercise_id || exerciseId,
                    });
                } else {
                    this._pushAssistantMessageToNlux(responseText);
                }
            }
            if (
                this._isExerciseCompletedPayload(
                    response?.raw || response?.result || response
                )
            ) {
                this.completeProcess();
            }
        } catch (error) {
            console.warn("[AiSidebar] skip step failed:", error);
            this.notification.add(_t("Could not skip to the next step."), {
                type: "danger",
            });
        } finally {
            this.state.skipStepLoading = false;
        }
    }
    // Bootstrap Offcanvas helpers
    _runOffcanvasOp(fn) {
        this._offcanvasQueue = (this._offcanvasQueue || Promise.resolve())
            .then(() => fn())
            .catch((e) => console.warn("[ai_sidebar] offcanvas op failed:", e));
        return this._offcanvasQueue;
    }

    async _waitOffcanvasStable(el, timeout = 1200) {
        if (!el) return;
        if (!el.classList.contains("hiding") && !el.classList.contains("showing")) return;

        await Promise.race([
            this._waitEvent(el, "hidden.bs.offcanvas", timeout),
            this._waitEvent(el, "shown.bs.offcanvas", timeout),
            new Promise((r) => setTimeout(r, timeout)),
        ]);
    }

    _getOffcanvasEl() {
        return this.containerRef?.el || document.getElementById("offcanvasAiSidebar");
    }

    _getBsOffcanvas() {
        return this._getBsOffcanvasInstance({ create: true });
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

    _scheduleChatLayoutSync() {
        if (this._chatLayoutSyncRaf) return;

        this._chatLayoutSyncRaf = requestAnimationFrame(() => {
            this._chatLayoutSyncRaf = null;

            const root = this.chatUiRef?.el;
            if (!root) return;

            const composer = root.querySelector(".nlux-composer-container");
            if (composer) {
                const nextWidth = composer.offsetWidth;
                const nextHeight = composer.offsetHeight;
                const panel = this.chatPanelRef?.el || root.closest(".ai-chat-panel");
                const panelRect = panel?.getBoundingClientRect();
                const composerRect = composer.getBoundingClientRect();
                const nextTopOffset = panelRect
                    ? Math.max(0, Math.round(panelRect.bottom - composerRect.top))
                    : nextHeight;
                if (this.state.composerWidth !== nextWidth) {
                    this.state.composerWidth = nextWidth;
                }
                if (this.state.composerHeight !== nextHeight) {
                    this.state.composerHeight = nextHeight;
                }
                if (this.state.composerTopOffset !== nextTopOffset) {
                    this.state.composerTopOffset = nextTopOffset;
                }
            }

            this._setupComposerOverflowTracking();
            this._syncComposerOverflowState();
            this._syncComposerDisabledState();
            this._syncHintScrollPadding();
        });
    }

    _setupComposerOverflowTracking() {
        const composerInput = this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea");
        if (!composerInput) {
            this._teardownComposerOverflowTracking();
            return;
        }

        if (this._composerOverflowInput === composerInput) {
            return;
        }

        this._teardownComposerOverflowTracking();

        this._composerOverflowInput = composerInput;
        this._composerOverflowHandler = () => {
            requestAnimationFrame(() => this._syncComposerOverflowState());
        };

        composerInput.addEventListener("input", this._composerOverflowHandler);
        composerInput.addEventListener("scroll", this._composerOverflowHandler);

        requestAnimationFrame(() => this._syncComposerOverflowState());
    }

    _syncComposerOverflowState() {
        const composerInput = this._composerOverflowInput || this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea");
        if (!composerInput) return;

        const hasOverflow = composerInput.scrollHeight > composerInput.clientHeight + 2;
        composerInput.classList.toggle("is-overflowing", hasOverflow);
    }

    _teardownComposerOverflowTracking() {
        if (this._composerOverflowInput && this._composerOverflowHandler) {
            this._composerOverflowInput.removeEventListener("input", this._composerOverflowHandler);
            this._composerOverflowInput.removeEventListener("scroll", this._composerOverflowHandler);
        }
        this._composerOverflowInput = null;
        this._composerOverflowHandler = null;
    }

    _focusComposerInput() {
        if (this.state.exerciseChoicePending) return;
        if (this._hasManualSelection()) return;

        const composerInput =
            this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea, .nlux-composer-container input");
        if (!composerInput) return;

        requestAnimationFrame(() => {
            if (this.state.exerciseChoicePending) return;
            if (this._hasManualSelection()) return;
            try {
                composerInput.focus({ preventScroll: true });
            } catch {
                composerInput.focus();
            }
        });
    }

    _afterShown() {
        this._normalizeDomAfterTransitions();
        this._ensureBackdropVisible();
        this.aiChatStore?.markOpen?.(true);
        this._syncConversationReadState();

        if (!this.state.showRecorderPanel) {
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        }

        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

        this._sendCurrentLiveContext();

        this._flushPendingTutorMessages?.();
        this._scheduleConversationReadStateSync?.();
        if (this.state.hintVisible && this.state.hintMessage && !this.state.hintExiting) {
            this._scheduleInlineHintAutoHide?.();
        }
        this._focusComposerInput();
    }

    _afterHidden() {
        document.body.classList.remove("o_ai_pick_mode");
        this.aiChatStore?.markOpen?.(false);
        this._normalizeDomAfterTransitions();
        this._forceOffcanvasCleanup();
        this._disposeBsOffcanvas();
        this.state.isLoading = false;
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
        this._resetInlineHintState?.({ clearMessage: true });
    }

    async hideSidebar() {
        return this._runOffcanvasOp(async () => {
            const el = this._getOffcanvasEl();
            if (!el) return;

            document.body.classList.remove("o_ai_pick_mode");
            await this._waitOffcanvasStable(el, 1200);

            const bs = this._getBsOffcanvas();
            if (!bs) {
                el.classList.remove("show");
                this._normalizeDomAfterTransitions();
                this._forceOffcanvasCleanup();
                this._disposeBsOffcanvas();
                return;
            }

            const p = this._waitEvent(el, "hidden.bs.offcanvas", 1200);
            bs.hide();
            const ok = await p;

            if (!ok) {
                el.classList.remove("show");
                el.setAttribute("aria-hidden", "true");
                el.removeAttribute("aria-modal");
                this._normalizeDomAfterTransitions();
                this._forceOffcanvasCleanup();
                this._disposeBsOffcanvas();
            }
        });
    }

    async showSidebar() {
        return this._runOffcanvasOp(async () => {
            const el = this._getOffcanvasEl();
            if (!el) return;

            document.body.classList.remove("o_ai_pick_mode");
            await this._waitOffcanvasStable(el, 1200);

            const bs = this._getBsOffcanvas();
            if (!bs) {
                el.classList.add("show");
                this._ensureBackdropVisible();
                this._focusComposerInput();
                return;
            }

            const p = this._waitEvent(el, "shown.bs.offcanvas", 1200);
            bs.show();
            await p;
            this._ensureBackdropVisible();
            this._focusComposerInput();
        });
    }

    async onCloseSidebar() {
        await this.hideSidebar();
        window.dispatchEvent(new CustomEvent(SIDEBAR_CLOSED_EVENT, {
            detail: { source: "header_close" },
        }));
    }
    // Recorder / Pick
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
        this._closeFeedbackPopover();

        if (!this.state.showRecorderPanel) {
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            window.dispatchEvent(new Event("resize"));
            this._focusComposerInput();
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
            this.state.recorderStatus = "idle";
            this.state.recorderSessionId = null;
            this.state.recorderPicked = null;
            this.state.recorderPicking = false;
            this.state.recorderNote = "";
            this.state.recorderStepIndex = 0;
            this.state.recorderFeed = [];
            this._savedStepHashes = new Set();
            this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

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
        await this.hideSidebar();
        document.body.classList.add("o_ai_pick_mode");

        try {
            const picked = await this.aiRecorder.pickTarget({ timeoutMs: 30000 });
            if (picked) this.state.recorderPicked = picked;
        } catch (e) {
            console.warn("[ai_recorder] pick failed:", e);
        } finally {
            document.body.classList.remove("o_ai_pick_mode");
            await this.showSidebar();
            this.state.recorderPicking = false;
        }
    }

    _getBsOffcanvasClass() {
        return window.bootstrap?.Offcanvas || null;
    }

    _getBsOffcanvasInstance({ create = false } = {}) {
        const el = this._getOffcanvasEl();
        const Offcanvas = this._getBsOffcanvasClass();
        if (!el || !Offcanvas) return null;

        const opts = { backdrop: true, keyboard: true, scroll: false };
        return create ? Offcanvas.getOrCreateInstance(el, opts) : Offcanvas.getInstance(el);
    }

    _disposeBsOffcanvas() {
        const inst = this._getBsOffcanvasInstance({ create: false });
        if (!inst) return;
        try {
            inst.dispose();
        } catch (e) {}
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
        const stepId = crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

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

        const dedupeKey = [payload.recorder_session_id, payload.step_index, payload.target || "", payload.instruction || ""].join("|");
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

    _queueTutorMessage(text, timestamp = null, meta = {}) {
        const cleaned = String(text || "").trim();
        if (!cleaned) return;
        const displayText = translateKnownTutorText(cleaned);

        const queue = getTutorPendingQueue();
        const exerciseId = this._normalizeExerciseId(meta.exerciseId);
        const allowExercisePromptWhileActive = !!meta.allowExercisePromptWhileActive;
        const key = `${displayText}__${timestamp || ""}__${exerciseId || ""}`;

        const alreadyQueued = queue.some((item) => item.key === key);
        if (alreadyQueued) return;

        queue.push({
            key,
            text: displayText,
            timestamp: timestamp || new Date().toISOString(),
            exerciseId,
            allowExercisePromptWhileActive,
        });

        if (queue.length > 50) {
            queue.splice(0, queue.length - 50);
        }
    }

    _flushPendingTutorMessages() {
        if (!this.aiChat) return;
        if (!this._isSidebarOpen()) return;

        const queue = getTutorPendingQueue();
        if (!queue.length) return;

        const pending = queue.splice(0, queue.length);
        const failed = [];

        for (const item of pending) {
            const cleaned = String(item.text || "").trim();
            if (!cleaned) continue;
            const displayText = translateKnownTutorText(cleaned);

            if (this._isDuplicateAssistantText(displayText)) {
                if (item.exerciseId) {
                    this._scheduleExerciseActionsForLastMessage(
                        item.exerciseId,
                        80,
                        0,
                        null,
                        { allowWhileActive: !!item.allowExercisePromptWhileActive }
                    );
                }
                continue;
            }

            const preserveScroll = this._shouldPreserveScrollForIncomingMessage();
            const inserted = this._pushAssistantMessageToNlux(displayText, {
                exerciseId: item.exerciseId || null,
                allowExercisePromptWhileActive: !!item.allowExercisePromptWhileActive,
                preserveScroll,
            });

            if (inserted) {
                this._lastInjectedTutorText = displayText;
                this._lastInjectedTutorAt = Date.now();
            } else {
                failed.push(item);
            }
        }

        if (failed.length) {
            queue.push(...failed);
        }

        requestAnimationFrame(() => {
            this._ensureCopyButtons?.();
            this._installManualSelectionGuard?.();
            this._scheduleConversationReadStateSync?.();
        });
    }

    _isSidebarOpen() {
        const el = this._getOffcanvasEl();
        return !!el?.classList?.contains("show");
    }
    // WS Tutor Push
    _setupHistoryListener() {
        if (this._historySubscribed) return;

        if (!this._historyReadyPromise) {
            this._historyReadyPromise = new Promise((resolve) => {
                this._resolveHistoryReady = resolve;
            });
            // Never let a slow/failed history fetch block the welcome message forever.
            setTimeout(() => {
                this._resolveHistoryReady?.();
                this._resolveHistoryReady = null;
            }, 4000);
        }

        this._onHistoryLoaded = (ev) => {
            const payload = ev?.kind ? ev.data : ev;
            const sessionId = payload?.session_id;
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];

            if (this._historyRenderedForSessionId === sessionId) return;
            this._historyRenderedForSessionId = sessionId;

            try {
                this._renderHistory(messages);
            } finally {
                this._resolveHistoryReady?.();
                this._resolveHistoryReady = null;
            }
        };

        this._onHistoryLoadedEvent = (e) => this._onHistoryLoaded({ kind: "history", data: e?.detail });

        try {
            this.aiWs?.subscribe?.(this._onHistoryLoaded);
            this._historySubscribed = true;
        } catch (e) {
            console.warn("[AiSidebar] history subscribe failed:", e);
        }
        window.addEventListener("ai:history_loaded", this._onHistoryLoadedEvent);
    }

    _teardownHistoryListener() {
        try {
            if (this._onHistoryLoaded) this.aiWs?.unsubscribe?.(this._onHistoryLoaded);
        } catch {}
        if (this._onHistoryLoadedEvent) {
            window.removeEventListener("ai:history_loaded", this._onHistoryLoadedEvent);
        }
        this._onHistoryLoaded = null;
        this._onHistoryLoadedEvent = null;
        this._historySubscribed = false;
    }

    _buildManualSentItem(text) {
        const item = document.createElement("div");
        item.className = "nlux-comp-chatItem nlux-comp-chatItem--sent nlux-comp-chatItem--bubblesLayout";
        item.innerHTML = `<div class="nlux-comp-message"><div class="nlux-markdown-container">${this._escapeHtml(text).replace(/\n/g, "<br/>")}</div></div>`;
        return item;
    }

    _renderHistory(messages) {
        const root = this.chatUiRef?.el;
        if (!root || !Array.isArray(messages) || messages.length === 0) return;

        this._ensureConversationVisible();

        const segments = root.querySelector(".nlux-chatSegments-container");
        if (!segments) {
            console.warn("[AiSidebar] NLUX segments container not found for history render");
            return;
        }

        for (const entry of messages) {
            const text = String(entry?.text || "").trim();
            if (!text) continue;

            const item =
                entry.role === "user"
                    ? this._buildManualSentItem(text)
                    : this._buildManualReceivedItem(text);
            segments.appendChild(item);
        }

        try {
            this._anchorEl = segments.lastElementChild;
            this._startLockToAnchor();
        } catch (_) {}

        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }

    _setupTutorPushListener() {
        if (this._tutorPushSubscribed) return;

        this._onTutorPush = async (ev) => {
            if (this._historyReadyPromise) {
                try {
                    await this._historyReadyPromise;
                } catch {}
            }

            const msg = ev?.kind ? ev.data : ev;
            if (!msg || typeof msg !== "object") return;

            if (!TUTOR_PUSH_TYPES.has(msg.type)) return;

            const text =
                msg.response ||
                msg.message ||
                msg.content ||
                msg.text ||
                "";

            const cleaned = String(text || "").trim();
            if (!cleaned) return;
            const displayText = this._prepareAssistantDisplayText(
                cleaned,
                this._extractCopyTargets(msg)
            );
            const isExerciseCompleted = this._isExerciseCompletedPayload(msg);

            const allowExercisePromptWhileActive = this._isExerciseResumePromptText(cleaned);
            const exerciseId = this._registerExercisePrompt(this._extractExerciseId(msg), {
                allowWhileActive: allowExercisePromptWhileActive,
            });
            const isWelcomePrompt = this._isWelcomePromptPayload(msg);

            if (exerciseId && isWelcomePrompt) {
                this._pauseExerciseTimer({ reason: "welcome" });
            }

            if (isExerciseCompleted) {
                this.completeProcess();
            }

            const normalized = normalizeAssistantTextForCompare(cleaned);

            console.log("[AI SIDEBAR tutor_push]", {
                type: msg.type,
                cleaned,
                normalized,
                chatReady: !!this.aiChat,
                sidebarOpen: this._isSidebarOpen(),
            });

            if (this._isDuplicateAssistantText(displayText)) {
                if (exerciseId) {
                    this._scheduleExerciseActionsForLastMessage(
                        exerciseId,
                        80,
                        0,
                        null,
                        { allowWhileActive: allowExercisePromptWhileActive }
                    );
                }
                return;
            }

            const preserveScroll = this._shouldPreserveScrollForIncomingMessage();
            this.aiChatStore?.addTutorPush?.(msg, {
                unread: !this._isSidebarOpen() || preserveScroll,
            });

            // Queue the message if chat is not ready or the sidebar is closed.
            if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                this._queueTutorMessage(displayText, msg.timestamp, {
                    exerciseId,
                    allowExercisePromptWhileActive,
                });
                return;
            }

                // Insert the message when the sidebar is open.
            const inserted = this._pushAssistantMessageToNlux(displayText, {
                exerciseId,
                allowExercisePromptWhileActive,
                preserveScroll,
            });

            if (inserted) {
                this._lastInjectedTutorText = displayText;
                this._lastInjectedTutorAt = Date.now();
            } else {
                // Keep the message if insertion fails.
                this._queueTutorMessage(displayText, msg.timestamp, {
                    exerciseId,
                    allowExercisePromptWhileActive,
                });
            }
        };

        try {
            this.aiWs?.subscribe?.(this._onTutorPush);
            this._tutorPushSubscribed = true;
        } catch (e) {
            console.warn("[AiSidebar] aiWs.subscribe failed:", e);
        }
    }

    _teardownTutorPushListener() {
        try {
            if (this._onTutorPush) this.aiWs?.unsubscribe?.(this._onTutorPush);
        } catch {}
        this._onTutorPush = null;
    }

    _pushAssistantMessageToNlux(text, options = {}) {
        if (!this.aiChat) return false;
        const displayText = translateKnownTutorText(text);

        const allowExercisePromptWhileActive = !!options.allowExercisePromptWhileActive;
        const preserveScroll = !!options.preserveScroll;
        const preservedScrollTop = preserveScroll ? this._captureConversationScrollTop() : null;
        const exerciseId = this._registerExercisePrompt(options.exerciseId, {
            allowWhileActive: allowExercisePromptWhileActive,
        });

        this._ensureConversationVisible();
        const receivedCountBefore = this._getReceivedMessageCount();

        // First, try the direct NLUX API.
        if (typeof this.aiChat.addMessage === "function") {
            try {
                this.aiChat.addMessage({
                    role: "assistant",
                    content: displayText,
                });

                requestAnimationFrame(() => {
                    if (preserveScroll) {
                        this._restoreConversationScrollTop(preservedScrollTop);
                    }
                    this._scheduleConversationReadStateSync();
                    if (exerciseId) {
                        this._scheduleExerciseActionsForLastMessage(
                            exerciseId,
                            80,
                            receivedCountBefore + 1,
                            null,
                            { allowWhileActive: allowExercisePromptWhileActive }
                        );
                    }
                    this._ensureCopyButtons?.();
                    this._installManualSelectionGuard?.();
                });

                return true;
            } catch (e) {
                console.warn("[AiSidebar] aiChat.addMessage failed:", e);
            }
        }

        // Next, try the alternate NLUX API.
        if (typeof this.aiChat.pushMessage === "function") {
            try {
                this.aiChat.pushMessage({
                    role: "assistant",
                    content: displayText,
                });

                requestAnimationFrame(() => {
                    if (preserveScroll) {
                        this._restoreConversationScrollTop(preservedScrollTop);
                    }
                    this._scheduleConversationReadStateSync();
                    if (exerciseId) {
                        this._scheduleExerciseActionsForLastMessage(
                            exerciseId,
                            80,
                            receivedCountBefore + 1,
                            null,
                            { allowWhileActive: allowExercisePromptWhileActive }
                        );
                    }
                    this._ensureCopyButtons?.();
                    this._installManualSelectionGuard?.();
                });

                return true;
            } catch (e) {
                console.warn("[AiSidebar] aiChat.pushMessage failed:", e);
            }
        }

        // Fall back to the DOM and use the latest message as a template.
        const root = this.chatUiRef?.el;
        if (!root) return false;

        const segments = root.querySelector(".nlux-chatSegments-container");
        if (!segments) return false;

        const receivedItems = Array.from(
            root.querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received")
        );
        const templateItem = receivedItems[receivedItems.length - 1] || null;

        let item = null;

        if (templateItem) {
            item = templateItem.cloneNode(true);

            // Remove elements added by this module.
            item.querySelectorAll(
                ".ai_feedback_bar, .ai-msg-footer, .ai-copy-btn, .ai_feedback_popover, .ai-exercise-actions"
            ).forEach((el) => el.remove());

            const md =
                item.querySelector(".nlux-markdown-container") ||
                item.querySelector(".nlux-comp-messageContent") ||
                item.querySelector(".nlux-comp-messageText");

            if (md) {
                md.innerHTML = this._escapeHtml(text).replace(/\n/g, "<br/>");
                if (md.hasAttribute?.("nlux-message-id")) {
                    md.setAttribute(
                        "nlux-message-id",
                        `tutor_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
                    );
                }
            } else {
                const msgRoot =
                    item.querySelector(".nlux-comp-message") ||
                    item.querySelector(".nlux-comp-bubble") ||
                    item;

                const body = document.createElement("div");
                body.className = "nlux-markdown-container";
                body.innerHTML = this._escapeHtml(text).replace(/\n/g, "<br/>");
                msgRoot.appendChild(body);
            }
        } else {
            item = this._buildManualReceivedItem(text);
        }

        segments.appendChild(item);

        if (exerciseId) {
            this._attachExerciseActions(item, exerciseId, {
                allowWhileActive: allowExercisePromptWhileActive,
            });
        }

        try {
            if (preserveScroll) {
                this._restoreConversationScrollTop(preservedScrollTop);
            } else {
                this._anchorEl = item;
                this._startLockToAnchor();
                this._syncConversationReadState();
            }
        } catch {}

        requestAnimationFrame(() => {
            if (preserveScroll) {
                this._restoreConversationScrollTop(preservedScrollTop);
            }
            this._scheduleConversationReadStateSync();
            this._ensureCopyButtons?.();
            this._installManualSelectionGuard?.();
            window.dispatchEvent(new Event("resize"));
        });

        return true;
    }
    // Chat (NLUX)
    updateChatPlaceholder(newPlaceholder) {
        if (this.aiChat && this.aiChat.updateComposerOptions) {
            this.aiChat.updateComposerOptions({ placeholder: newPlaceholder });
        }
    }

    _syncColorScheme() {
        const colorScheme = getCurrentColorScheme();
        if (this.state.colorScheme !== colorScheme) {
            this.state.colorScheme = colorScheme;
        }
        this._applyColorSchemeToChat(colorScheme);
    }

    _applyColorSchemeToChat(colorScheme = this.state.colorScheme) {
        const theme = colorScheme === "dark" ? "dark" : "light";
        const root = this.chatUiRef?.el?.querySelector(".nlux-AiChat-root");
        if (root && root.getAttribute("data-color-scheme") !== theme) {
            root.setAttribute("data-color-scheme", theme);
        }
    }

    async sendMessage(message) {
        this._expectingAssistant = true;
        let data;
        const currentContext = this.state.currentContext || this.contextService?.getContext?.() || {};
        const safeContext = {
            ...currentContext,
            model: currentContext.model || this._getCurrentBreadcrumbPath() || "base",
        };

        try {
            if (!this.aiWs?.chat) {
                throw new Error("El chat seguro no está conectado. Recarga Odoo AI Tutor e inténtalo de nuevo.");
            }
            data = await this.aiWs.chat({ message, context: safeContext });
        } catch (error) {
            data = { error: true, response: error?.message || String(error) };
        }
        const text = this._prepareAssistantDisplayText(
            this._extractResponseText(data),
            this._extractCopyTargets(data)
        );
        return {
            result: {
                response: text,
                exercise_id: this._extractExerciseId(data),
                copy_targets: this._extractCopyTargets(data),
            },
            raw: data,
            response: text,
        };
    }

    createAiChat() {
        this._cancelPendingExerciseActions();

        if (this.aiChat) {
            try {
                this.aiChat.unmount();
            } catch {}
            this.aiChat = null;
        }

        const adapter = this.state.isStreamingMode
            ? { streamText: this.streamText.bind(this) }
            : { batchText: this.batchText.bind(this) };

        const { partnerId, writeDate } = user;
        const userAvatar = imageUrl("res.partner", partnerId, "avatar_256", { unique: writeDate });
        const theme = getCurrentColorScheme();
        this.state.colorScheme = theme;

        this.aiChat = globalThis["@nlux/core"]
            .createAiChat()
            .withAdapter(adapter)
            .withDisplayOptions({ colorScheme: theme })
            .withConversationOptions({ historyPayloadSize: "max", conversationStarters: [] })
            .withComposerOptions({ placeholder: this.state.placeholder, autoFocus: true })
            .withPersonaOptions({
                assistant: { name: "IAbot", avatar: "/odoo_tutor/static/images/iabotv2.png", tagline: "Your helpful AI assistant!" },
                user: { name: user.name, avatar: userAvatar },
            })
            .withMessageOptions({ waitTimeBeforeStreamCompletion: "never" });

        this._removeManualSelectionGuard?.();

        this.aiChat.mount(this.chatUiRef.el);

        this._waitAndInitAntiAutoScroll();
        this._initFeedbackObserver();

        requestAnimationFrame(() => {
            this._flushPendingTutorMessages?.();
            this._startCopyButtonsObserver?.();
            this._installManualSelectionGuard?.();
            this._setupComposerOverflowTracking();
            this._syncComposerOverflowState();
            this._applyColorSchemeToChat();
            this._focusComposerInput();
        });
    }

    async reset() {
        const pendingQueue = getTutorPendingQueue();
        pendingQueue.splice(0, pendingQueue.length);
        this._lastInjectedTutorText = null;
        this._lastInjectedTutorAt = 0;
        this._clearStoredActiveExercise();
        this._cancelPendingExerciseActions();
        this.aiChatStore?.markRead?.();
        this.aiChatStore?.clearTutorPushes?.();

        this.createAiChat();

        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
        this._timerStartedAtMs = null;
        this.state.isLoading = false;
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseId = null;
        this.state.exerciseChoicePending = false;
        this.state.exerciseCancelLoading = false;
        this.state.skipStepLoading = false;
        this.state.timerInterval = null;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        this.state.timerSeconds = 0;
        this.state.timerValue = "00:00:00";
        this._syncComposerDisabledState();

        window.__AI_TUTOR_OWL_PREVIEW__ = {
            message: "",
            timestamp: "",
            visible: false,
        };

        window.dispatchEvent(new CustomEvent("ai:preview_reset"));

        try {
            await this.aiWs.restart({ reason: "ui_reset", clearSession: true });
        } catch (e) {
            console.warn("[ai_sidebar] ws restart failed:", e);
        }

        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

        this._sendCurrentLiveContext({ force: true });

        requestAnimationFrame(() => {
            this._startCopyButtonsObserver?.();
            this._focusComposerInput();
        });
    }

    async batchText(message) {
        this._expectingAssistant = true;
        this.state.isLoading = true;
        this._cancelPendingExerciseActions();
        const receivedCountBefore = this._getReceivedMessageCount();

        try {
            const response = await this.sendMessage(message);
            const messageText = response.result.response;
            const exercise_id = this._getPromptExerciseId(response.result.exercise_id);
            const isWelcomePrompt = this._isWelcomePromptPayload(response.result || response);
            const isExerciseCompleted = this._isExerciseCompletedPayload(response.raw || response.result || response);

            if (exercise_id) {
                this._registerExercisePrompt(exercise_id);
                if (isWelcomePrompt) {
                    this._pauseExerciseTimer({ reason: "welcome" });
                }
                setTimeout(
                    () => this._scheduleExerciseActionsForLastMessage(exercise_id, 80, receivedCountBefore + 1),
                    0
                );
            } else if (!this.state.processActive) {
                this._cancelPendingExerciseActions();
                this.state.showButtons = false;
                this.state.exerciseId = null;
            }

            if (isExerciseCompleted) {
                this.completeProcess();
            }

            return new String(messageText);
        } catch (error) {
            return `Error: ${error.message}`;
        } finally {
            this.state.isLoading = false;
            setTimeout(() => {
                this._expectingAssistant = false;
            }, 0);
        }
    }

    async streamText(message, observer) {
        this._expectingAssistant = true;
        this.state.isLoading = true;

        try {
            this.onMessage = (content) => observer.next(String(content));
            this.onStop = () => {
                this.state.isLoading = false;
                this._expectingAssistant = false;
                observer.complete();
            };

            const response = await this.sendMessage(message);

            if (response.stream) {
                response.stream.pipeTo(
                    new WritableStream({
                        write: (chunk) => this.onMessage(chunk),
                        close: () => this.onStop(),
                    })
                );
            } else {
                this.state.isLoading = false;
                this._expectingAssistant = false;
            }
        } catch (error) {
            this.state.isLoading = false;
            this._expectingAssistant = false;
            observer.error(`AI Error: ${error.message}`);
        }
    }

    _getExerciseStorage() {
        try {
            if (window.localStorage) return window.localStorage;
        } catch {}
        try {
            if (window.sessionStorage) return window.sessionStorage;
        } catch {}
        return null;
    }

    _getActiveExerciseStorageKey() {
        const sess = (window.odoo && odoo.session_info) || {};
        const db = sess.db || "default_db";
        const uid = sess.uid || user.userId || user.id || "default_user";
        return `${ACTIVE_EXERCISE_STORAGE_KEY}:${db}:${uid}`;
    }

    _readStoredActiveExercise() {
        const storage = this._getExerciseStorage();
        if (!storage) return null;

        const key = this._getActiveExerciseStorageKey();
        try {
            const raw = storage.getItem(key);
            if (!raw) return null;

            const data = JSON.parse(raw);
            const exerciseId = this._normalizeExerciseId(data?.exerciseId || data?.exercise_id);
            const startedAt = Number(data?.startedAt);
            const paused = data?.paused === true || data?.timerPaused === true;
            const elapsedSeconds = Math.max(0, Math.floor(Number(data?.elapsedSeconds) || 0));
            const now = Date.now();

            if (!exerciseId || (!Number.isFinite(startedAt) && !paused)) {
                storage.removeItem(key);
                return null;
            }

            const effectiveStartedAt = Number.isFinite(startedAt)
                ? startedAt
                : now - elapsedSeconds * 1000;

            if (effectiveStartedAt > now + 60000 || now - effectiveStartedAt > ACTIVE_EXERCISE_MAX_AGE_MS) {
                storage.removeItem(key);
                return null;
            }

            return {
                exerciseId,
                startedAt: effectiveStartedAt,
                paused,
                elapsedSeconds: paused ? elapsedSeconds : Math.max(0, Math.floor((now - effectiveStartedAt) / 1000)),
            };
        } catch {
            try {
                storage.removeItem(key);
            } catch {}
            return null;
        }
    }

    _persistActiveExercise({ exerciseId, startedAt, paused = false, elapsedSeconds = null }) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        if (!normalizedExerciseId || !Number.isFinite(Number(startedAt))) return;

        const storage = this._getExerciseStorage();
        if (!storage) return;

        try {
            storage.setItem(
                this._getActiveExerciseStorageKey(),
                JSON.stringify({
                    exerciseId: normalizedExerciseId,
                    startedAt: Number(startedAt),
                    paused: !!paused,
                    elapsedSeconds: Math.max(0, Math.floor(Number(elapsedSeconds) || 0)),
                    updatedAt: Date.now(),
                    wsSessionId: window.__AI_TUTOR_WS_SESSION_ID || null,
                    contextModel: this.state.currentContext?.model || null,
                })
            );
        } catch {}
    }

    _clearStoredActiveExercise() {
        const storage = this._getExerciseStorage();
        if (!storage) return;
        try {
            storage.removeItem(this._getActiveExerciseStorageKey());
        } catch {}
    }

    _formatTimerValue(totalSeconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;
        return (
            `${hours.toString().padStart(2, "0")}:` +
            `${minutes.toString().padStart(2, "0")}:` +
            `${seconds.toString().padStart(2, "0")}`
        );
    }

    _setTimerSeconds(totalSeconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        this.state.timerSeconds = safeSeconds;
        this.state.timerValue = this._formatTimerValue(safeSeconds);
    }

    _startExerciseTimer(startedAt = Date.now()) {
        const startedAtMs = Number(startedAt) || Date.now();
        this._timerStartedAtMs = startedAtMs;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        if (this.state.timerInterval) {
            clearInterval(this.state.timerInterval);
            this.state.timerInterval = null;
        }

        const tick = () => {
            this._setTimerSeconds((Date.now() - startedAtMs) / 1000);
        };

        tick();
        this.state.timerInterval = setInterval(tick, 1000);
    }

    _pauseExerciseTimer({ reason = "" } = {}) {
        if (!this.state.processActive || this.state.timerPaused) return;

        const elapsedSeconds = this._timerStartedAtMs
            ? (Date.now() - this._timerStartedAtMs) / 1000
            : this.state.timerSeconds;

        if (this.state.timerInterval) {
            clearInterval(this.state.timerInterval);
            this.state.timerInterval = null;
        }

        this._setTimerSeconds(elapsedSeconds);
        this.state.timerPaused = true;
        this.state.timerPausedReason = reason;
        this._timerStartedAtMs = null;

        const normalizedExerciseId = this._normalizeExerciseId(this.state.exerciseId);
        if (normalizedExerciseId) {
            this._persistActiveExercise({
                exerciseId: normalizedExerciseId,
                startedAt: Date.now() - this.state.timerSeconds * 1000,
                paused: true,
                elapsedSeconds: this.state.timerSeconds,
            });
        }
    }

    _resumeExerciseTimer({ exerciseId = this.state.exerciseId } = {}) {
        if (!this.state.processActive) return;

        const normalizedExerciseId = this._normalizeExerciseId(exerciseId);
        if (normalizedExerciseId) {
            this.state.exerciseId = normalizedExerciseId;
        }

        const startedAt = Date.now() - (this.state.timerSeconds || 0) * 1000;
        this._startExerciseTimer(startedAt);
        this._persistActiveExercise({
            exerciseId: normalizedExerciseId,
            startedAt,
            paused: false,
            elapsedSeconds: this.state.timerSeconds,
        });
    }

    _restoreActiveExerciseSession() {
        const stored = this._readStoredActiveExercise();
        if (!stored || this.state.processActive) return false;

        this._cancelPendingExerciseActions();
        this.state.exerciseId = stored.exerciseId;
        this.state.showButtons = false;
        this.state.processActive = true;
        this.state.exerciseChoicePending = false;
        this._syncComposerDisabledState();
        if (stored.paused) {
            this._setTimerSeconds(stored.elapsedSeconds);
            this.state.timerPaused = true;
            this.state.timerPausedReason = "welcome";
            this.state.timerInterval = null;
            this._timerStartedAtMs = null;
        } else {
            this._startExerciseTimer(stored.startedAt);
        }
        return true;
    }
    // Process UI
    startProcess(exerciseId = null, options = {}) {
        const normalizedExerciseId = this._normalizeExerciseId(exerciseId) || this._normalizeExerciseId(this.state.exerciseId);
        const startedAt = Number(options.startedAt) || Date.now();
        this._cancelPendingExerciseActions();
        if (normalizedExerciseId) {
            this.state.exerciseId = normalizedExerciseId;
        }
        this.state.showButtons = false;
        this.state.processActive = true;
        this.state.exerciseChoicePending = false;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        this._syncComposerDisabledState();
        this._startExerciseTimer(startedAt);
        this._persistActiveExercise({
            exerciseId: normalizedExerciseId,
            startedAt,
            paused: false,
            elapsedSeconds: 0,
        });
    }

    cancelProcess() {
        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
        this._timerStartedAtMs = null;
        this._clearStoredActiveExercise();
        this._cancelPendingExerciseActions();
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseId = null;
        this.state.exerciseCancelLoading = false;
        this.state.timerInterval = null;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        this.state.timerSeconds = 0;
        this.state.timerValue = "00:00:00";
    }

    completeProcess() {
        if (this.state.timerInterval) {
            clearInterval(this.state.timerInterval);
        }

        this._timerStartedAtMs = null;
        this._clearStoredActiveExercise();
        this._cancelPendingExerciseActions();
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseChoicePending = false;
        this.state.exerciseCancelLoading = false;
        this.state.timerInterval = null;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        this.state.exerciseId = null;
    }

    async showResultModal() {
        this.state.finishLoading = true;

        try {
            const response = await fetch("/ai_chat/validate_exercise", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
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
    // Anti auto-scroll
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

    _getConversationContainer() {
        return this._conv || this.chatUiRef?.el?.querySelector(".nlux-conversation-container") || null;
    }

    // Keep the hint as an overlay so it does not shift chat layout or scroll position.
    _syncHintScrollPadding() {
        const conv = this._getConversationContainer();
        if (!conv) return;
        conv.style.paddingBottom = "";
    }

    _isConversationNearBottom(threshold = 72) {
        const conv = this._getConversationContainer();
        if (!conv) return true;
        const distance = conv.scrollHeight - conv.scrollTop - conv.clientHeight;
        return distance <= threshold;
    }

    _getNewestConversationItem() {
        const conv = this._getConversationContainer();
        if (!conv) return null;
        const items = conv.querySelectorAll(".nlux-comp-chatItem");
        return items.length ? items[items.length - 1] : null;
    }

    _isNewestConversationItemVisible() {
        const conv = this._getConversationContainer();
        const newest = this._getNewestConversationItem();
        if (!conv || !newest) return true;

        const convRect = conv.getBoundingClientRect();
        const newestRect = newest.getBoundingClientRect();
        const visibleTop = Math.max(newestRect.top, convRect.top);
        const visibleBottom = Math.min(newestRect.bottom, convRect.bottom);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const minimumVisibleHeight = Math.min(96, Math.max(32, newestRect.height * 0.2));

        return visibleHeight >= minimumVisibleHeight || newestRect.bottom <= convRect.bottom + 96;
    }

    _syncConversationReadState() {
        const atBottom = this._isConversationNearBottom() || this._isNewestConversationItemVisible();
        this.aiChatStore?.setAtBottom?.(atBottom);
        return atBottom;
    }

    _scheduleConversationReadStateSync() {
        if (this._conversationReadSyncTimer) {
            clearTimeout(this._conversationReadSyncTimer);
            this._conversationReadSyncTimer = null;
        }

        requestAnimationFrame(() => {
            this._syncConversationReadState();
            this._conversationReadSyncTimer = setTimeout(() => {
                this._conversationReadSyncTimer = null;
                this._syncConversationReadState();
            }, 180);
        });
    }

    _shouldPreserveScrollForIncomingMessage() {
        return (
            this._isSidebarOpen() &&
            !!this._getConversationContainer() &&
            !this._isConversationNearBottom(96) &&
            !this._isNewestConversationItemVisible()
        );
    }

    _captureConversationScrollTop() {
        const conv = this._getConversationContainer();
        return conv ? conv.scrollTop : null;
    }

    _restoreConversationScrollTop(scrollTop) {
        const conv = this._getConversationContainer();
        if (!conv || scrollTop === null || scrollTop === undefined) return;
        conv.scrollTop = scrollTop;
        requestAnimationFrame(() => {
            const latestConv = this._getConversationContainer();
            if (latestConv) {
                latestConv.scrollTop = scrollTop;
            }
        });
    }

    _scrollConversationToBottom({ smooth = false } = {}) {
        const conv = this._getConversationContainer();
        if (!conv) {
            this.aiChatStore?.markRead?.();
            this.aiChatStore?.setAtBottom?.(true);
            return;
        }

        try {
            conv.scrollTo({
                top: conv.scrollHeight,
                behavior: smooth ? "smooth" : "auto",
            });
        } catch {
            conv.scrollTop = conv.scrollHeight;
        }

        this.aiChatStore?.markRead?.();
        this.aiChatStore?.setAtBottom?.(true);
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

        this._onManualConversationScroll = () => {
            this._userScrollingUntil = performance.now() + 1200;
            if (this._lockActive) {
                this._stopLock();
            }
        };

        this._conv.addEventListener("wheel", this._onManualConversationScroll, { passive: true });
        this._conv.addEventListener("touchstart", this._onManualConversationScroll, { passive: true });
        this._conv.addEventListener("pointerdown", this._onManualConversationScroll, { passive: true });

        this._onConversationReadScroll = () => {
            this._syncConversationReadState();
        };
        this._conv.addEventListener("scroll", this._onConversationReadScroll, { passive: true });
        this._syncConversationReadState();

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
            this._scheduleConversationReadStateSync();
        });

        this._observerAA.observe(this._segments, { childList: true, subtree: true });
    }

    _teardownAntiAutoScroll() {
        if (this._conv && this._onManualConversationScroll) {
            this._conv.removeEventListener("wheel", this._onManualConversationScroll);
            this._conv.removeEventListener("touchstart", this._onManualConversationScroll);
            this._conv.removeEventListener("pointerdown", this._onManualConversationScroll);
        }
        this._onManualConversationScroll = null;
        if (this._conv && this._onConversationReadScroll) {
            this._conv.removeEventListener("scroll", this._onConversationReadScroll);
        }
        this._onConversationReadScroll = null;
        if (this._observerAA) {
            this._observerAA.disconnect();
            this._observerAA = null;
        }
        this._stopLock();
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
        if (performance.now() < this._userScrollingUntil) return;
        const target = Math.max(0, this._topWithin(this._anchorEl, this._conv) - 8);
        this._conv.scrollTop = target;
    }

    _startLockToAnchor() {
        if (!this._anchorEl || !this._conv) return;
        if (performance.now() < this._userScrollingUntil) return;
        this._lockActive = true;

        const lockMs = 900;
        const start = performance.now();

        const tick = () => {
            if (!this._lockActive) return;
            if (performance.now() < this._userScrollingUntil) {
                this._stopLock();
                return;
            }
            this._stickToAnchor();

            if (performance.now() - start < lockMs) {
                this._lockRaf = requestAnimationFrame(tick);
            } else {
                this._lockActive = false;
            }
        };
        this._lockRaf = requestAnimationFrame(tick);
    }

    _stopLock() {
        this._lockActive = false;
        if (this._lockRaf) cancelAnimationFrame(this._lockRaf);
        this._lockRaf = null;
        this._anchorEl = null;
    }
    // Feedback
    _initFeedbackObserver() {
        if (this._feedbackObserver) return;
        const root = this.chatUiRef?.el;
        if (!root) return;

        const attachToExisting = () => {
            root
                .querySelectorAll(".nlux-comp-chatItem.nlux-comp-chatItem--received")
                .forEach((item) => this._injectFeedbackBar(item));

            requestAnimationFrame(() => {
                this._ensureCopyButtons?.();
            });
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
        this._closeFeedbackPopover();
    }

    _setComposerAutoFocus(enabled) {
        try {
            if (this.aiChat?.updateComposerOptions) {
                this.aiChat.updateComposerOptions({ autoFocus: !!enabled });
            }
        } catch {}

        const composerInput =
            this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea, .nlux-composer-container input");
        if (!enabled && composerInput) composerInput.blur();
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

    _setSelectedVote(barEl, vote) {
        barEl.querySelectorAll(".ai_feedback_btn").forEach((b) => b.classList.remove("is-active"));
        const target = barEl.querySelector(`.ai_feedback_btn[data-action="${vote}"]`);
        if (target) target.classList.add("is-active");
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
                return;
            }

            if (action === "down") {
                this._setSelectedVote(bar, "down");
                this._submitAiFeedback({
                    message_uid: messageUid,
                    vote: "down",
                    comment: "",
                    message_body_html: html,
                    message_body_text: text,
                });
                return;
            }

            if (action === "comment") {
                this._toggleFeedbackQuickPopover({
                    chatItemEl,
                    anchorBtn: btn,
                    messageUid,
                    messageHtml: html,
                    messageText: text,
                });
                return;
            }
        });

        messageRoot.appendChild(bar);

        requestAnimationFrame(() => {
            this._ensureCopyButtons?.();
        });
    }

    _toggleFeedbackQuickPopover({ chatItemEl, anchorBtn, messageUid, messageHtml, messageText }) {
        if (this._activeFeedbackPopover) this._closeFeedbackPopover();

        const portal = this.chatUiRef?.el || this.containerRef?.el;
        if (!portal || !anchorBtn) return;

        const pop = document.createElement("div");
        pop.className = "ai_feedback_popover ai_feedback_popover--quick";
        pop.dataset.messageUid = messageUid;

        pop.innerHTML = `
          <div class="ai_feedback_popover_title">${_t("Quick feedback")}</div>

          <div class="ai_feedback_quick_grid">
            <button type="button" class="ai_feedback_quick_btn" data-act="excellent">
              <i class="fa fa-star"></i><span>${_t("Excellent")}</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="unclear">
              <i class="fa fa-question-circle"></i><span>${_t("Unclear")}</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="technical">
              <i class="fa fa-wrench"></i><span>${_t("Technical issue")}</span>
            </button>

            <button type="button" class="ai_feedback_quick_btn" data-act="comment">
              <i class="fa fa-comment"></i><span>${_t("Comment")}</span>
            </button>
          </div>

          <div class="ai_feedback_actions">
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

        const onClick = (ev) => {
            const btn = ev.target.closest("button");
            if (!btn) return;

            const act = btn.dataset.act;
            if (!act) return;

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
                    title: _t("What was unclear?"),
                    placeholder: _t("Tell us what felt confusing or incomplete..."),
                    presetVote: "down",
                });
                return;
            }

            if (act === "technical") {
                closeAndOpenTextarea({
                    eventName: "ai_feedback_technical_issue",
                    title: _t("Describe the technical issue"),
                    placeholder: _t("What went wrong? (error, stuck, wrong output, etc.)"),
                    presetVote: "",
                });
                return;
            }

            if (act === "comment") {
                closeAndOpenTextarea({
                    eventName: "ai_feedback",
                    title: _t("Feedback about this answer"),
                    placeholder: _t("Tell us what we can improve..."),
                    presetVote: "",
                });
                return;
            }
        };

        pop.addEventListener("click", onClick, true);

        const onDocMouseDown = (e) => {
            if (!pop.contains(e.target) && e.target !== anchorBtn) this._closeFeedbackPopover();
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

    _forceOffcanvasCleanup() {
        if (document.querySelector(".offcanvas.show")) return;

        document.querySelectorAll(".offcanvas-backdrop").forEach((b) => b.remove());
        document.body.classList.remove("offcanvas-open");

        if (!document.querySelector(".modal.show")) {
            document.body.classList.remove("modal-open");
            document.body.style.removeProperty("overflow");
            document.body.style.removeProperty("padding-right");
        }
    }

    _toggleFeedbackPopover({
        chatItemEl,
        anchorBtn,
        messageUid,
        messageHtml,
        messageText,
        eventName = "ai_feedback",
        title = _t("Feedback about this answer"),
        placeholder = _t("Tell us what we can improve..."),
        presetVote = "",
    }) {
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
        pop.dataset.eventName = eventName;
        pop.dataset.presetVote = presetVote;

        pop.innerHTML = `
          <div class="ai_feedback_popover_title">${title}</div>
          <textarea class="ai_feedback_text" rows="3" placeholder="${placeholder}"></textarea>
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
            if (!pop.contains(e.target) && e.target !== anchorBtn) this._closeFeedbackPopover();
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

        if (pop._onQuickClick) pop.removeEventListener("click", pop._onQuickClick, true);

        this._setComposerAutoFocus(true);

        pop.remove();
        this._activeFeedbackPopover = null;
        this._focusComposerInput();
    }

    async _submitAiFeedback(payload, opts = {}) {
        const fullPayload = { ...payload, context: this.state.currentContext };
        const eventName = opts?.eventName || "ai_feedback";

        return this.aiWs
            .sendEvent({
                type: "feedback_event",
                event_name: eventName,
                event_data: fullPayload,
                awaitAck: true,
            })
            .then(() => {
                this.notification.add(_t("Feedback sent. Thank you for helping improve the tutor!"), {
                    type: "success",
                });
            })
            .catch((e) => {
                console.warn("[ai_sidebar] feedback send failed:", e);
                this.notification.add(_t("Could not send your feedback."), { type: "danger" });
            });
    }
    // Resize
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
