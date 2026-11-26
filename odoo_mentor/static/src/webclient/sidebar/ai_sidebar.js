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
import {
    buildTutorStepKey,
    isDuplicateTutorAssistantMessage,
    shouldQueueTutorMessage,
} from "../../core/tutor_message_delivery";
import {
    applyPolishedInstructionsToSteps,
    buildDraftStepFromEvent,
    buildPickedStepInstruction,
    buildPolishDraftPayload,
    buildRecorderModuleOptions,
    buildRecordingDraftPayload,
    buildStepLocateActionRequest,
    captureDeletedStepEntries,
    checkDryRunToggleAlreadySatisfied,
    detectOptionalBlockSuggestions,
    extractExerciseExplorerModules,
    extractModuleFromApp,
    extractNavigateToModule,
    filterExercisesForExplorer,
    findAppForModule,
    getNextIndexAfterSkip,
    getOptionalBlockRange,
    getPreviousDryRunIndex,
    hydrateDraftForEditing,
    insertStepsAt,
    isRecorderUiElement,
    matchDryRunStepIndex,
    moveStepByOffset,
    moveStepToIndex,
    normalizeExerciseExplorerItem,
    recomputeOptionalGroups,
    reconcileDryRunAfterStepInsertion,
    reconcileDryRunAfterStepMove,
    reconcileDryRunAfterStepRemoval,
    restoreDeletedStepEntries,
    shouldSuppressModuleGatePrompt,
} from "../../core/recording_draft";
import {
    buildActiveSuspectWarnings,
    dismissStepSuspectWarning,
} from "../../core/mistake_detection";
import { normalizeDomEvent } from "../../core/normalize_event";
import { TUTOR_PLANS_URL } from "../../core/settings_navigation";
import { renderInlineMarkdownHtml } from "../../core/format_markdown";
import {
    extractTargetHint,
    resolveTargetElement,
    shouldAutoShowTargetHint,
} from "../../core/target_hint_resolver";
import {
    hideTargetHintOverlay,
    showTargetHintOverlay,
} from "../../core/target_hint_overlay";

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
    const raw = String(value || "").trim();
    const normalized = normalizeAssistantTextForCompare(raw);

    if (normalized === "do you want to continue the exercise?") {
        return _t("Do you want to continue the exercise?");
    }

    return raw;
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

    // Inspect rendered Odoo surfaces before falling back to the color_scheme cookie.
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

const TUTOR_ASSISTANT_AVATAR_URL = "/odoo_mentor/static/images/iabotv2.png";
const ACTIVE_EXERCISE_STORAGE_KEY = "odoo_tutor.active_exercise_session";
const ACTIVE_EXERCISE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const EXERCISE_CTA_STATE_KEY = "__AI_TUTOR_EXERCISE_CTA__";
const EXERCISE_CTA_EVENT = "ai:exercise_cta_update";
const EXERCISE_CHOICE_EVENT = "ai:exercise_choice";
const SIDEBAR_CLOSED_EVENT = "ai:sidebar_closed";
const EXERCISE_SKIP_STEP_EVENT = "ai:exercise_skip_step";
const DRY_RUN_STATE_KEY = "__AI_TUTOR_DRY_RUN_STATE__";
const DRY_RUN_UPDATE_EVENT = "ai:dry_run_update";
const DRY_RUN_ACTION_EVENT = "ai:dry_run_action";

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
        this.menuService = useService("menu");
        this.actionService = useService("action");
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
        this._lastInjectedTutorStepKey = null;
        this._contextAckSubscribed = false;
        this._pendingRedirectStepWaiter = null;

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
        this._polishRequestSeq = 0;
        this._editedDuringPolishStepIds = new Set();

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
            recorderTitle: "",
            recorderModule: "",
            recorderModuleOptions: buildRecorderModuleOptions(),
            recorderSteps: [],
            recorderSaving: false,
            recorderPolishing: false,
            recorderPrePolishSnapshot: null,
            recorderFeed: [],
            recorderStepIndex: 0,
            recorderNote: "",
            recorderPicked: null,
            recorderPicking: false,

            dryRunActive: false,
            dryRunPaused: false,
            dryRunStepIndex: 0,
            dryRunEditStepId: null,
            dryRunSkippedPromptStepId: null,
            dryRunSkippedPromptStepNumber: null,
            dryRunAlreadySatisfied: null,
            selectedRecorderStepIds: [],
            dismissedBlockSuggestionIds: [],
            recorderLocatingStepId: null,
            recorderUndoStack: [],
            recorderInsertAt: null,
            recorderInsertMulti: false,
            recorderInsertCapturing: false,
            recorderRecentInsertedStepId: null,
            recorderDragStepId: null,
            recorderDragOverStepId: null,
            recorderDragOverPosition: null,

            wsStatus: "unknown",
            showRecorderPanel: false,
            canSeeRecorderToggle: false,
            canReviewRecordings: false,
            recorderTab: "record", // record | review | exercises
            recorderReviewTab: false,
            reviewQueue: [],
            reviewLoading: false,
            reviewDetail: null,
            reviewComment: "",
            reviewPublishFailure: null,

            explorerExercises: [],
            explorerLoading: false,
            explorerUsingFallback: false,
            explorerQuery: "",
            explorerModuleFilter: "",
            explorerStatusFilter: "published",
            explorerScopeFilter: "tenant",
            explorerSelectedId: null,
            explorerDetail: null,
            explorerDetailLoading: false,
            explorerConfirmDeleteId: null,
            explorerDeletingId: null,

            hintMessage: "",
            hintTimestamp: null,
            hintTarget: null,
            activeStepTarget: null,
            hintVisible: false,
            hintHovered: false,
            hintExiting: false,
            hintCycle: 0,
        });

        this._reinforceStepKey = null;
        this._reinforceCount = 0;

        this.onShowTargetHint = async () => {
            const target = this.state.hintTarget || this.state.activeStepTarget;
            if (!target) return;
            const shown = showTargetHintOverlay(target);
            if (!shown) {
                this.notification?.add?.(
                    _t("The target element is not visible on this screen yet."),
                    { type: "info" }
                );
                return;
            }
            if (this._isSidebarOpen?.()) {
                await this.hideSidebar();
                showTargetHintOverlay(target);
            }
        };

        this._clearTargetHintState = () => {
            this._reinforceStepKey = null;
            this._reinforceCount = 0;
            this.state.activeStepTarget = null;
            this.state.hintTarget = null;
            hideTargetHintOverlay();
        };

        this._syncStepTargetFromPayload = (payload) => {
            const target = extractTargetHint(payload);
            if (payload && typeof payload === "object" && payload.current_step !== undefined) {
                const stepKey = `${payload.exercise_id || this.state.exerciseId || ""}:${payload.current_step ?? ""}`;
                if (this._reinforceStepKey !== stepKey) {
                    this._reinforceStepKey = stepKey;
                    this._reinforceCount = 0;
                    this.state.activeStepTarget = target || null;
                    this.state.hintTarget = null;
                    hideTargetHintOverlay();
                    return;
                }
            }
            if (target) {
                this.state.activeStepTarget = target;
            }
        };

        window.aiTutorDebug = window.aiTutorDebug || {};

        window.aiTutorDebug.showHint = (text, timestamp = new Date().toISOString(), target = null) => {
            this._setInlineHint(text, timestamp, target);
        };

        window.aiTutorDebug.hideHint = () => {
            this.closeInlineHint();
        };

        window.aiTutorDebug.showTargetHint = (target, caption) => {
            return showTargetHintOverlay(target, caption ? { caption } : {});
        };

        window.aiTutorDebug.hideTargetHint = () => {
            hideTargetHintOverlay();
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

        this._setInlineHint = (text, timestamp, target = null) => {
            const cleaned = (text || "")
                .toString()
                .replace(/\*\*/g, "")
                .replace(/\n+/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            if (!cleaned) return;

            const resolvedTarget =
                extractTargetHint({ target }) ||
                (target && typeof target === "object" ? target : null) ||
                this.state.activeStepTarget ||
                null;
            const translated = translateKnownTutorText(cleaned);
            if (
                this.state.hintVisible &&
                !this.state.hintExiting &&
                this.state.hintMessage === translated
            ) {
                this._clearInlineHintTimers();
                this.state.hintTimestamp = normalizeTutorTimestamp(timestamp);
                if (resolvedTarget) this.state.hintTarget = resolvedTarget;
                this.state.hintHovered = false;
                this._scheduleInlineHintAutoHide();
                return;
            }

            this._clearInlineHintTimers();
            this.state.hintMessage = translated;
            this.state.hintTimestamp = normalizeTutorTimestamp(timestamp);
            this.state.hintTarget = resolvedTarget;
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

            this._restoreRecorderSession();
            this._loadRecorderPermission();
            this._loadRecorderModuleOptions();
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
                if (!ev) return;

                if (ev.event_type === "STEP_UPDATED" && ev.step?.id) {
                    const updatedSteps = (this.state.recorderSteps || []).map((s) =>
                        s?.id === ev.step.id ? ev.step : s
                    );
                    this.state.recorderSteps = updatedSteps;
                    return;
                }

                if (ev.event_type === "STEP_GENERATED" && ev.step) {
                    const stepId = ev.step.id;
                    const insertIdx = Number.isInteger(ev.insert_index) ? ev.insert_index : null;
                    const res = insertStepsAt(this.state.recorderSteps || [], [ev.step], insertIdx);
                    if (res.insertedCount > 0) {
                        this.state.recorderSteps = res.steps;
                        if (insertIdx !== null) {
                            this._reconcileDryRunForInsertion(res.insertedIndex, res.insertedCount);
                            this._flashInsertedStep(stepId);
                        }
                    }
                    return;
                }

                if (ev.event_type === "INSERT_CAPTURE_COMPLETED") {
                    this.state.recorderInsertCapturing = false;
                    this.state.recorderInsertAt = null;
                    this.state.recorderStatus = "paused";
                    this.showSidebar?.();
                    if (ev.step?.id) {
                        this._flashInsertedStep(ev.step.id);
                        this._scrollToRecorderStep?.(ev.step.id);
                    }
                    this.notification?.add?.(
                        _t("Inserted step #%s.", (Number(ev.insert_index) || 0) + 1),
                        { type: "success" }
                    );
                    return;
                }

                if (ev.event_type === "INSERT_CURSOR_ADVANCED") {
                    if (Number.isInteger(ev.next_index)) {
                        this.state.recorderInsertAt = ev.next_index;
                    }
                    this.notification?.add?.(
                        _t("Inserted step #%s. Perform the next action or pause.", (Number(ev.insert_index) || 0) + 1),
                        { type: "info" }
                    );
                    return;
                }

                if (ev.event_type !== "STEP_SAVED") return;

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

                const hintTarget = extractTargetHint(msg);
                if (hintTarget) {
                    this.state.activeStepTarget = hintTarget;
                }
                this._setInlineHint(text, msg.timestamp, hintTarget);
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

            this._onDryRunActionEvent = (e) => {
                this._handleDryRunAction(e?.detail || {});
            };
            window.addEventListener(DRY_RUN_ACTION_EVENT, this._onDryRunActionEvent);

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

            if (this._onDryRunActionEvent) {
                window.removeEventListener(DRY_RUN_ACTION_EVENT, this._onDryRunActionEvent);
                this._onDryRunActionEvent = null;
            }
            this._detachDryRunListeners();

            if (this.state.timerInterval) {
                clearInterval(this.state.timerInterval);
                this.state.timerInterval = null;
            }

            this._cancelRedirectStepWaiter?.();

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

            if (targets?.length) {
                textBlock.dataset.copyHighlighted = "1";
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
            ".ai-copy-btn, .ai_feedback_btn, .ai-exercise-actions, .ai-quota-actions, .ai-copy-value"
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

    get plansUrl() {
        return TUTOR_PLANS_URL;
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

    _isDuplicateAssistantText(text, { stepKey = null } = {}) {
        const normalized = normalizeAssistantTextForCompare(text);
        const lastInjectedText = normalizeAssistantTextForCompare(this._lastInjectedTutorText || "");
        const lastDomText = (this._getRecentAssistantTextsFromDom?.(1) || [])[0] || "";
        return isDuplicateTutorAssistantMessage({
            normalizedText: normalized,
            stepKey,
            lastInjectedText,
            lastInjectedAt: this._lastInjectedTutorAt || 0,
            lastInjectedStepKey: this._lastInjectedTutorStepKey || null,
            lastDomText,
        });
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
        item.innerHTML = `<div class="nlux-comp-chatItem-participantInfo"><div class="nlux-comp-avatar"><div class="nlux-comp-avatarContainer"><div class="nlux-comp-avatarPicture" style="background-image: url('${TUTOR_ASSISTANT_AVATAR_URL}')"></div></div></div></div><div class="nlux-comp-message"><div class="nlux-markdown-container">${renderInlineMarkdownHtml(text)}</div></div>`;
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
            const hasExpectedCount = minReceivedCount <= 0 || receivedCount >= minReceivedCount;
            const item = hasExpectedCount && receivedCount > 0
                ? receivedItems[receivedCount - 1]
                : null;
            if (item) {
                if (item.querySelector(".ai-exercise-actions")) return;
                if (this._attachExerciseActions(item, normalizedExerciseId, options)) {
                    requestAnimationFrame(() => this._scrollConversationToBottom?.());
                    return;
                }
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

    _scheduleQuotaActionsForLastMessage(minReceivedCount = 0, attempts = 80) {
        requestAnimationFrame(() => {
            const receivedItems = Array.from(
                this.chatUiRef?.el?.querySelectorAll(
                    ".nlux-comp-chatItem.nlux-comp-chatItem--received"
                ) || []
            );
            const receivedCount = receivedItems.length;
            const targetIndex = minReceivedCount > 0 ? minReceivedCount - 1 : receivedCount - 1;
            const item = targetIndex >= 0 ? receivedItems[targetIndex] : null;
            if (item) {
                if (item.querySelector(".ai-quota-actions")) return;
                if (this._attachQuotaActions(item)) return;
            }
            if (attempts > 1) {
                window.setTimeout(
                    () => this._scheduleQuotaActionsForLastMessage(minReceivedCount, attempts - 1),
                    40
                );
            }
        });
    }

    _attachQuotaActions(itemEl) {
        if (!itemEl) return false;
        if (itemEl.querySelector(".ai-quota-actions")) return true;

        const messageHost = this._getMessageHost(itemEl);
        const textBlock = this._getMessageTextBlock(messageHost);
        if (!messageHost || !textBlock) return false;

        this._trimMessageBlockEnd(textBlock);

        const actions = document.createElement("div");
        actions.className = "ai-quota-actions";
        const planLink = document.createElement("a");
        planLink.className = "ai-quota-plan-btn";
        planLink.href = TUTOR_PLANS_URL;
        planLink.target = "_blank";
        planLink.rel = "noopener noreferrer";
        planLink.setAttribute("aria-label", _t("Get a subscription"));
        planLink.textContent = _t("Get a subscription");
        actions.appendChild(planLink);

        textBlock.appendChild(actions);
        return true;
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

    _cancelRedirectStepWaiter() {
        const waiter = this._pendingRedirectStepWaiter;
        if (!waiter) return;
        this._pendingRedirectStepWaiter = null;
        clearTimeout(waiter.timer);
        if (!waiter.settled) {
            waiter.settled = true;
            waiter.resolve(null);
        }
    }

    _waitForRedirectInstructionPush(exerciseId = null, timeoutMs = 2200) {
        this._cancelRedirectStepWaiter();
        return new Promise((resolve) => {
            const waiter = {
                exerciseId: this._normalizeExerciseId(exerciseId),
                settled: false,
                resolve,
                timer: setTimeout(() => {
                    if (this._pendingRedirectStepWaiter === waiter) {
                        this._pendingRedirectStepWaiter = null;
                    }
                    if (!waiter.settled) {
                        waiter.settled = true;
                        resolve(null);
                    }
                }, timeoutMs),
            };
            this._pendingRedirectStepWaiter = waiter;
        });
    }

    async _autoNavigateToExerciseModule(payload) {
        const targetModule = extractNavigateToModule(payload);
        if (!targetModule) return false;

        const apps = this.menuService?.getApps?.() || [];
        const targetApp = findAppForModule(apps, targetModule);
        const currentApp = this.menuService?.getCurrentApp?.() || null;
        const beforeCtx = this.contextService?.getContext?.() || this.state.currentContext || {};
        const beforeModel = String(beforeCtx?.model || "").trim().toLowerCase();
        const isHomeMenuOpen = !!document.querySelector(".o_home_menu, .o_apps");

        let navigated = false;
        let switchedApp = false;

        if (targetApp && this.menuService?.selectMenu) {
            switchedApp = currentApp?.id !== targetApp.id;
            // Always select the target app's root menu so exercises start
            // consistently from the app's home view (even when the user is
            // already inside a record form or submenu of the same app).
            try {
                await this.menuService.selectMenu(targetApp);
                navigated = true;
            } catch (e) {
                console.warn("[AiSidebar] auto module selectMenu failed:", e);
                return false;
            }
        } else if (targetModule === "base" && this.actionService?.doAction) {
            try {
                await this.actionService.doAction("base.action_general_configuration");
                switchedApp = beforeModel !== "res.config.settings" || isHomeMenuOpen;
                navigated = true;
            } catch (e) {
                console.warn("[AiSidebar] auto Settings navigation failed:", e);
                return false;
            }
        }

        if (!navigated) return false;

        const deadline = Date.now() + 1500;
        const resolvedAt = Date.now();
        let latestCtx = this.contextService?.getContext?.() || this.state.currentContext;

        while (Date.now() < deadline) {
            latestCtx = this.contextService?.getContext?.() || latestCtx;
            const latestModel = String(latestCtx?.model || "").trim().toLowerCase();
            const isValidModel =
                Boolean(latestModel) &&
                latestModel !== "unknown" &&
                latestModel !== "ir.ui.menu";
            if (isValidModel) {
                const modelChanged = !switchedApp || !beforeModel || latestModel !== beforeModel;
                if (modelChanged || Date.now() - resolvedAt >= 600) {
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 60));
        }

        if (latestCtx) {
            this.state.currentContext = latestCtx;
        }
        this.state.breadcrumbPath = this._getCurrentBreadcrumbPath();

        const contextModel = latestCtx?.model || this.state.currentContext?.model;
        if (contextModel) {
            try {
                await this.aiWs?.sendLiveContext?.({
                    context_model: contextModel,
                    route: this._getLiveContextRoute(),
                    force: true,
                });
            } catch (_) {}
        }

        return true;
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
            const rawPayload = response?.raw || response;
            const redirected =
                action === "start" ? await this._autoNavigateToExerciseModule(rawPayload) : false;
            this._syncStepTargetFromPayload(rawPayload);
            const responseText = this._prepareAssistantDisplayText(
                this._extractResponseText(response),
                this._extractCopyTargets(response)
            );

            const stepKey = buildTutorStepKey(rawPayload, normalizedExerciseId);
            if (
                !shouldSuppressModuleGatePrompt(rawPayload, redirected) &&
                responseText &&
                !this._isDuplicateAssistantText(responseText, { stepKey })
            ) {
                // Queue the response while the sidebar is closed to preserve chat order.
                if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                    this._queueTutorMessage(responseText, response?.raw?.timestamp || response?.timestamp, {
                        exerciseId: response?.raw?.exercise_id || normalizedExerciseId,
                        stepKey,
                    });
                } else {
                    const inserted = this._pushAssistantMessageToNlux(responseText);
                    if (inserted) {
                        this._lastInjectedTutorText = responseText;
                        this._lastInjectedTutorAt = Date.now();
                        this._lastInjectedTutorStepKey = stepKey;
                    }
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
            const rawPayload = response?.raw || response;
            this._syncStepTargetFromPayload(rawPayload);
            const stepKey = buildTutorStepKey(rawPayload, exerciseId);
            const responseText = getVisibleSkipResponse(
                response,
                (payload) =>
                    this._prepareAssistantDisplayText(
                        this._extractResponseText(payload),
                        this._extractCopyTargets(payload)
                    ),
                (text) => this._isDuplicateAssistantText(text, { stepKey })
            );
            if (responseText) {
                // Queue the response while the sidebar is closed to preserve chat order.
                if (shouldQueueTutorMessage({ aiChat: this.aiChat, isSidebarOpen: this._isSidebarOpen() })) {
                    this._queueTutorMessage(responseText, response?.raw?.timestamp || response?.timestamp, {
                        exerciseId: response?.raw?.exercise_id || exerciseId,
                        stepKey,
                    });
                } else {
                    const inserted = this._pushAssistantMessageToNlux(responseText);
                    if (inserted) {
                        this._lastInjectedTutorText = responseText;
                        this._lastInjectedTutorAt = Date.now();
                        this._lastInjectedTutorStepKey = stepKey;
                    }
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
                const inputRect = composer.querySelector('textarea')?.getBoundingClientRect();
                if (panelRect && inputRect) {
                    panel.style.setProperty('--tutor-skip-bottom', `${panelRect.bottom - inputRect.top - inputRect.height / 2 - 14}px`);
                }
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

        if (!this.state.isChatInitialized && this.chatUiRef?.el) {
            this.createAiChat();
            this.state.isChatInitialized = true;
        }

        if (!this.state.showRecorderPanel) {
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        }

        if (this.state.dryRunActive && this.dryRunCurrentStep?.id) {
            this._refreshDryRunAlreadySatisfied();
            if (this.state.showRecorderPanel) {
                this._scrollToRecorderStep(this.dryRunCurrentStep.id);
            }
        }

        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

        this._sendCurrentLiveContext();

        this._flushPendingHistory?.();
        this._flushPendingTutorMessages?.({ preserveScroll: false });
        if (!this.state.showRecorderPanel) {
            this._scrollToLatestMessageOnOpen?.();
        }
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

        if (this.state.dryRunActive && this.state.dryRunPaused && (this.state.recorderSteps || []).length) {
            this.state.dryRunPaused = false;
            this.state.dryRunEditStepId = null;
            this._attachDryRunListeners();
            this._emitDryRunState();
        }
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
    _restoreRecorderSession() {
        const restored = this.aiRecorder?.getSessionState?.();
        if (
            !restored ||
            (restored.status !== "recording" && restored.status !== "paused") ||
            !restored.sessionId
        ) {
            return;
        }
        this.state.recorderStatus = restored.status;
        this.state.recorderSessionId = restored.sessionId;
        this.state.recorderTitle = restored.title || "";
        this.state.recorderModule = restored.module || "";
        this.state.recorderSteps = Array.isArray(restored.steps) ? restored.steps : [];
        this.state.recorderFeed = Array.isArray(restored.feed) ? restored.feed : [];
        this.state.recorderStepIndex = Number(restored.stepIndex) || 0;
        this.state.recorderNote = restored.note || "";

        if (restored.dryRun?.active && this.state.recorderSteps.length > 0) {
            this.state.dryRunActive = true;
            this.state.dryRunPaused = restored.dryRun.paused === true;
            this.state.dryRunStepIndex = Math.min(
                this.state.recorderSteps.length - 1,
                Math.max(0, Math.floor(Number(restored.dryRun.stepIndex) || 0))
            );
            this.state.dryRunEditStepId = restored.dryRun.editStepId || null;
            this.state.dryRunSkippedPromptStepId = restored.dryRun.skippedPromptStepId || null;
            this.state.dryRunSkippedPromptStepNumber =
                restored.dryRun.skippedPromptStepNumber || null;
            if (!this.state.dryRunPaused) {
                this._attachDryRunListeners();
            }
            this._emitDryRunState({ persist: false });
        }
    }

    async _loadRecorderPermission() {
        try {
            const [isExpert, isReviewer] = await Promise.all([
                user.hasGroup("odoo_mentor.group_odoo_tutor_expert"),
                user.hasGroup("odoo_mentor.group_odoo_tutor_reviewer"),
            ]);
            this.state.canSeeRecorderToggle = !!isExpert;
            this.state.canReviewRecordings = !!isReviewer;
            if (this.state.canSeeRecorderToggle && this.state.recorderStatus !== "idle") {
                this.state.showRecorderPanel = true;
            } else if (!this.state.canSeeRecorderToggle && this.state.recorderStatus !== "idle") {
                await this.onRecorderFinish();
            }
        } catch (e) {
            this.state.canSeeRecorderToggle = false;
            this.state.canReviewRecordings = false;
        }
    }

    _loadRecorderModuleOptions() {
        try {
            const apps = this.menuService?.getApps?.() || [];
            const options = buildRecorderModuleOptions(apps);
            this.state.recorderModuleOptions = options;
            if (this.state.recorderStatus === "idle" && !this.state.recorderModule) {
                const currentApp = this.menuService?.getCurrentApp?.();
                const currentModule = extractModuleFromApp(currentApp);
                if (currentModule && options.some((opt) => opt.value === currentModule)) {
                    this.state.recorderModule = currentModule;
                }
            }
        } catch (e) {
            this.state.recorderModuleOptions = buildRecorderModuleOptions();
        }
    }

    async toggleRecorderPanel() {
        if (!this.state.canSeeRecorderToggle) return;

        this.state.showRecorderPanel = !this.state.showRecorderPanel;
        this._closeFeedbackPopover();

        if (this.state.showRecorderPanel) {
            this._loadRecorderModuleOptions();
            if (this.state.dryRunActive && this.dryRunCurrentStep?.id) {
                this._scrollToRecorderStep(this.dryRunCurrentStep.id);
            }
        } else {
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            window.dispatchEvent(new Event("resize"));
            this._scrollToLatestMessageOnOpen?.();
            this._focusComposerInput();
        }
    }

    async onRecorderStart() {
        if (this.state.dryRunActive) {
            this.onRecorderStopDryRun();
        }
        if (this.state.recorderStatus === "paused") {
            await this.hideSidebar();
            const sid = await this.aiRecorder.resumeRecording();
            this.state.recorderSessionId = sid;
            this.state.recorderStatus = "recording";
            this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
            return;
        }
        const title = (this.state.recorderTitle || "").trim();
        const mod = (this.state.recorderModule || "").trim();
        if (!title || !mod) {
            this.notification.add(
                _t("Enter an exercise title and select an app/module before starting capture."),
                { type: "warning" }
            );
            return;
        }

        const apps = this.menuService?.getApps?.() || [];
        const selectedApp = findAppForModule(apps, mod);
        if (selectedApp && this.menuService?.selectMenu) {
            // Always navigate to the selected app's home view before starting
            // recording so every recorded exercise begins from a consistent screen.
            try {
                await this.menuService.selectMenu(selectedApp);
            } catch {}
        } else if (mod === "base" && this.actionService?.doAction) {
            try {
                await this.actionService.doAction("base.action_general_configuration");
            } catch {}
        }

        await this.hideSidebar();

        const sid = await this.aiRecorder.startRecording({
            exerciseId: this.state.exerciseId || null,
            title,
            module: mod,
            moduleRootXmlid: selectedApp?.xmlid || null,
        });
        this.state.recorderSessionId = sid;
        this.state.recorderStatus = "recording";
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    async onRecorderPause() {
        await this.aiRecorder.pauseRecording();
        this.state.recorderStatus = "paused";
        this.state.recorderInsertCapturing = false;
    }

    async onRecorderFinishCapture() {
        if (this.state.recorderStatus === "recording") {
            await this.aiRecorder.pauseRecording();
            this.state.recorderStatus = "paused";
        }
        if ((this.state.recorderSteps || []).length > 0) {
            // Fire a single batched AI polish pass non-blockingly so Save stays usable.
            this.onRecorderPolishSteps({ trigger: "finish" });
        }
    }

    async onRecorderPolishSteps({ trigger = "button" } = {}) {
        if (this.state.recorderPolishing) return;
        const steps = this.state.recorderSteps || [];
        if (!steps.length) {
            if (trigger === "button") {
                this.notification.add(_t("Record at least one step before polishing."), {
                    type: "warning",
                });
            }
            return;
        }

        let draft;
        try {
            draft = buildPolishDraftPayload({
                title: this.state.recorderTitle,
                module: this.state.recorderModule,
                steps,
            });
        } catch (err) {
            if (trigger === "button") {
                this.notification.add(err?.message || _t("Record at least one step before polishing."), {
                    type: "warning",
                });
            }
            return;
        }

        const requestSeq = ++this._polishRequestSeq;
        this._editedDuringPolishStepIds = new Set();
        const prePolishSnapshot = {};
        for (const step of steps) {
            if (step?.id) {
                prePolishSnapshot[step.id] = step.instruction;
            }
        }

        this.state.recorderPolishing = true;
        try {
            const result = await rpc("/ai_chat/recording_drafts/polish", { draft });
            if (requestSeq !== this._polishRequestSeq) {
                return;
            }
            if (result?.error) {
                this.notification.add(
                    trigger === "finish"
                        ? _t("Capture finished. AI polish unavailable — kept instant step labels.")
                        : result.error,
                    { type: trigger === "finish" ? "info" : "warning" }
                );
                return;
            }

            const { steps: updatedSteps, changedCount, flaggedCount } = applyPolishedInstructionsToSteps(
                this.state.recorderSteps || [],
                result?.data,
                { skipStepIds: this._editedDuringPolishStepIds }
            );
            this.state.recorderSteps = updatedSteps;
            this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
            if (this.state.dryRunActive) {
                this._emitDryRunState();
            }

            const totalFlagged = this.recorderSuspectCount;
            if (changedCount > 0 && totalFlagged > 0) {
                this.state.recorderPrePolishSnapshot = prePolishSnapshot;
                this.notification.add(
                    _t(
                        "Polished %s step(s) and flagged %s possible extra step(s) for review.",
                        changedCount,
                        totalFlagged
                    ),
                    { type: "info" }
                );
            } else if (changedCount > 0) {
                this.state.recorderPrePolishSnapshot = prePolishSnapshot;
                this.notification.add(
                    _t("Polished %s step instruction(s) with AI.", changedCount),
                    { type: "success" }
                );
            } else if (flaggedCount > 0) {
                this.notification.add(
                    _t("AI flagged %s possible extra step(s) for your review.", flaggedCount),
                    { type: "info" }
                );
            } else if (trigger === "button") {
                this.notification.add(_t("Step instructions are already clear."), { type: "info" });
            }
        } catch (err) {
            if (requestSeq !== this._polishRequestSeq) {
                return;
            }
            this.notification.add(
                trigger === "finish"
                    ? _t("Capture finished. AI polish unavailable — kept instant step labels.")
                    : err?.message || _t("Could not polish step instructions."),
                { type: trigger === "finish" ? "info" : "warning" }
            );
        } finally {
            if (requestSeq === this._polishRequestSeq) {
                this.state.recorderPolishing = false;
                this._editedDuringPolishStepIds = new Set();
            }
        }
    }

    onRecorderUndoPolish() {
        const snapshot = this.state.recorderPrePolishSnapshot;
        if (!snapshot || typeof snapshot !== "object") return;
        this.state.recorderSteps = (this.state.recorderSteps || []).map((step) => {
            if (!step?.id || !Object.prototype.hasOwnProperty.call(snapshot, step.id)) {
                return step;
            }
            const restoredInstruction = snapshot[step.id];
            const restoredStep = {
                ...step,
                instruction: restoredInstruction,
            };
            delete restoredStep.ai_polished;
            if (restoredStep.target_hint) {
                restoredStep.target_hint = {
                    ...restoredStep.target_hint,
                    actionLabel: restoredInstruction,
                };
            }
            return restoredStep;
        });
        this.state.recorderPrePolishSnapshot = null;
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
    }

    async onRecorderFinish() {
        const sid = this.state.recorderSessionId;
        this._polishRequestSeq += 1;
        this.state.recorderPolishing = false;
        this.state.recorderPrePolishSnapshot = null;
        this._editedDuringPolishStepIds = new Set();
        this.onRecorderStopDryRun();
        try {
            await this.aiRecorder.finishRecording();
        } finally {
            this.state.recorderStatus = "idle";
            this.state.recorderSessionId = null;
            this.state.recorderTitle = "";
            this.state.recorderModule = "";
            this.state.recorderSteps = [];
            this.state.selectedRecorderStepIds = [];
            this._lastSelectedRecorderStepId = null;
            this.state.recorderUndoStack = [];
            this.state.recorderInsertAt = null;
            this.state.recorderInsertCapturing = false;
            this.state.recorderRecentInsertedStepId = null;
            this.state.recorderPicked = null;
            this.state.recorderPicking = false;
            this.state.recorderNote = "";
            this.state.recorderStepIndex = 0;
            this.state.recorderFeed = [];
            this.state.selectedRecorderStepIds = [];
            this._lastSelectedRecorderStepId = null;
            this.state.dismissedBlockSuggestionIds = [];
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

    get recorderOptionalBlockSuggestions() {
        const dismissed = new Set(this.state.dismissedBlockSuggestionIds || []);
        return detectOptionalBlockSuggestions(this.state.recorderSteps || []).filter(
            (suggestion) => !dismissed.has(suggestion.id)
        );
    }

    get recorderSuspectWarnings() {
        return buildActiveSuspectWarnings(this.state.recorderSteps || []);
    }

    get recorderSuspectCount() {
        return Object.keys(this.recorderSuspectWarnings).length;
    }

    get dryRunCurrentStep() {
        const steps = this.state.recorderSteps || [];
        const idx = this.state.dryRunStepIndex || 0;
        return idx >= 0 && idx < steps.length ? steps[idx] : null;
    }

    onRecorderUpdateStepInstruction(stepId, value) {
        if (this.state.recorderPolishing && stepId) {
            this._editedDuringPolishStepIds?.add(stepId);
        }
        this.state.recorderSteps = (this.state.recorderSteps || []).map((step) => {
            if (step.id !== stepId) return step;
            const nextStep = { ...step, instruction: value };
            delete nextStep.ai_polished;
            return nextStep;
        });
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
    }

    onRecorderRemoveStep(stepId) {
        this.onRecorderRemoveStepIds([stepId]);
    }

    onRecorderRemoveStepIds(stepIds = [], { fromActivePrompt = false } = {}) {
        const idSet = new Set((Array.isArray(stepIds) ? stepIds : []).filter(Boolean));
        if (!idSet.size) return;

        const prevSteps = this.state.recorderSteps || [];
        const deletedEntries = captureDeletedStepEntries(prevSteps, Array.from(idSet));
        if (deletedEntries.length) {
            this.state.recorderUndoStack = [
                ...(this.state.recorderUndoStack || []).slice(-19),
                {
                    entries: deletedEntries,
                    count: deletedEntries.length,
                },
            ];
        }

        const reconciled = reconcileDryRunAfterStepRemoval(
            prevSteps,
            Array.from(idSet),
            this.state.dryRunActive
                ? {
                      active: true,
                      paused: this.state.dryRunPaused,
                      stepIndex: this.state.dryRunStepIndex,
                      editStepId: this.state.dryRunEditStepId,
                      skippedPromptStepId: this.state.dryRunSkippedPromptStepId,
                      skippedPromptStepNumber: this.state.dryRunSkippedPromptStepNumber,
                  }
                : null,
            { fromActivePrompt }
        );

        this.state.recorderSteps = reconciled.steps;
        if (Number.isInteger(this.state.recorderInsertAt)) {
            this.state.recorderInsertAt = Math.min(
                reconciled.steps.length,
                Math.max(0, this.state.recorderInsertAt)
            );
        }
        this.state.selectedRecorderStepIds = (this.state.selectedRecorderStepIds || []).filter(
            (id) => !idSet.has(id)
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });

        if (!this.state.dryRunActive) {
            return;
        }

        hideTargetHintOverlay();

        if (!reconciled.dryRun) {
            this.onRecorderStopDryRun();
            if (reconciled.completed && reconciled.steps.length > 0) {
                this.notification.add(
                    _t("Step removed — Dry-Run completed! All remaining steps verified."),
                    { type: "success" }
                );
            } else if (reconciled.completed) {
                this.notification.add(_t("All steps removed. Dry-Run stopped."), {
                    type: "info",
                });
            }
            return;
        }

        this.state.dryRunStepIndex = reconciled.dryRun.stepIndex;
        this.state.dryRunEditStepId = reconciled.dryRun.editStepId;
        this.state.dryRunSkippedPromptStepId = reconciled.dryRun.skippedPromptStepId;
        this.state.dryRunSkippedPromptStepNumber = reconciled.dryRun.skippedPromptStepNumber;
        if (!this.state.dryRunPaused) {
            this._attachDryRunListeners();
        }
        this._emitDryRunState();
        if (fromActivePrompt) {
            this.notification.add(_t("Step removed. Continuing Dry-Run."), { type: "info" });
        }
    }

    onRecorderKeepSuspectStep(stepId) {
        const warning = this.recorderSuspectWarnings[stepId];
        if (!warning?.signature) return;
        this.state.recorderSteps = dismissStepSuspectWarning(
            this.state.recorderSteps || [],
            stepId,
            warning.signature
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
    }

    get recorderLastUndoItem() {
        const stack = this.state.recorderUndoStack || [];
        return stack.length ? stack[stack.length - 1] : null;
    }

    get recorderInsertPreviousStep() {
        if (!Number.isInteger(this.state.recorderInsertAt) || this.state.recorderInsertAt <= 0) {
            return null;
        }
        const steps = this.state.recorderSteps || [];
        return steps[this.state.recorderInsertAt - 1] || null;
    }

    _flashInsertedStep(stepId) {
        if (!stepId) return;
        this.state.recorderRecentInsertedStepId = stepId;
        if (this._insertedStepFlashTimer) {
            clearTimeout(this._insertedStepFlashTimer);
        }
        this._insertedStepFlashTimer = setTimeout(() => {
            if (this.state.recorderRecentInsertedStepId === stepId) {
                this.state.recorderRecentInsertedStepId = null;
            }
            this._insertedStepFlashTimer = null;
        }, 2800);
    }

    _reconcileDryRunForInsertion(insertIndex, insertedCount) {
        if (!this.state.dryRunActive || insertedCount <= 0) return;
        const nextDryRun = reconcileDryRunAfterStepInsertion(
            {
                active: true,
                paused: this.state.dryRunPaused,
                stepIndex: this.state.dryRunStepIndex,
                editStepId: this.state.dryRunEditStepId,
                skippedPromptStepId: this.state.dryRunSkippedPromptStepId,
                skippedPromptStepNumber: this.state.dryRunSkippedPromptStepNumber,
            },
            insertIndex,
            insertedCount,
            (this.state.recorderSteps || []).length
        );
        if (nextDryRun) {
            this.state.dryRunStepIndex = nextDryRun.stepIndex;
            this.state.dryRunSkippedPromptStepNumber = nextDryRun.skippedPromptStepNumber;
            this._emitDryRunState();
        }
    }

    onRecorderUndoDelete() {
        const stack = (this.state.recorderUndoStack || []).slice();
        if (!stack.length) return;
        const last = stack.pop();
        this.state.recorderUndoStack = stack;

        const restored = restoreDeletedStepEntries(this.state.recorderSteps || [], last.entries);
        if (!restored.restoredCount) return;

        this.state.recorderSteps = restored.steps;
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });

        const firstEntryIndex = Math.min(
            ...last.entries.map((e) => Math.max(0, Number(e.index) || 0))
        );
        this._reconcileDryRunForInsertion(firstEntryIndex, restored.restoredCount);
        if (restored.restoredIds[0]) {
            this._flashInsertedStep(restored.restoredIds[0]);
            this._scrollToRecorderStep?.(restored.restoredIds[0]);
        }
        this.notification.add(
            restored.restoredCount === 1
                ? _t("Restored deleted step.")
                : _t("Restored %s deleted steps.", restored.restoredCount),
            { type: "success" }
        );
    }

    onRecorderDismissUndo() {
        this.state.recorderUndoStack = [];
    }

    onRecorderMoveStep(stepId, delta) {
        const moved = moveStepByOffset(this.state.recorderSteps || [], stepId, delta);
        if (!moved.moved) return;

        this.state.recorderSteps = moved.steps;
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });

        if (this.state.dryRunActive) {
            const nextDryRun = reconcileDryRunAfterStepMove(
                { active: true, stepIndex: this.state.dryRunStepIndex },
                moved.fromIndex,
                moved.toIndex
            );
            if (nextDryRun) {
                this.state.dryRunStepIndex = nextDryRun.stepIndex;
                this._emitDryRunState();
            }
        }
    }

    onRecorderDragStart(stepId, ev) {
        if (!stepId) return;
        this.state.recorderDragStepId = stepId;
        this.state.recorderDragOverStepId = null;
        this.state.recorderDragOverPosition = null;
        if (ev?.dataTransfer) {
            ev.dataTransfer.effectAllowed = "move";
            try {
                ev.dataTransfer.setData("text/plain", stepId);
            } catch {}
            const cardEl = ev.currentTarget?.closest?.(".o_ai_rec_feed_item");
            if (cardEl && ev.dataTransfer.setDragImage) {
                try {
                    ev.dataTransfer.setDragImage(cardEl, 18, 18);
                } catch {}
            }
        }
    }

    onRecorderDragOver(stepId, ev) {
        const dragId = this.state.recorderDragStepId;
        if (!dragId || !stepId || dragId === stepId) return;
        ev.preventDefault();
        if (ev.dataTransfer) {
            ev.dataTransfer.dropEffect = "move";
        }
        const rect = ev.currentTarget?.getBoundingClientRect?.();
        const pos = rect && ev.clientY > rect.top + rect.height / 2 ? "after" : "before";
        if (this.state.recorderDragOverStepId !== stepId || this.state.recorderDragOverPosition !== pos) {
            this.state.recorderDragOverStepId = stepId;
            this.state.recorderDragOverPosition = pos;
        }
    }

    onRecorderDrop(targetStepId, ev) {
        ev.preventDefault();
        const draggedId =
            this.state.recorderDragStepId || ev?.dataTransfer?.getData?.("text/plain") || null;
        const pos = this.state.recorderDragOverPosition || "before";
        this.onRecorderDragEnd();
        if (!draggedId || !targetStepId || draggedId === targetStepId) return;

        const steps = this.state.recorderSteps || [];
        const fromIdx = steps.findIndex((s) => s?.id === draggedId);
        const targetIdx = steps.findIndex((s) => s?.id === targetStepId);
        if (fromIdx < 0 || targetIdx < 0) return;

        let desiredIdx = pos === "after" ? targetIdx + 1 : targetIdx;
        if (fromIdx < desiredIdx) {
            desiredIdx -= 1;
        }
        const moved = moveStepToIndex(steps, draggedId, desiredIdx);
        if (!moved.moved) return;

        this.state.recorderSteps = moved.steps;
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });

        if (this.state.dryRunActive) {
            const nextDryRun = reconcileDryRunAfterStepMove(
                { active: true, stepIndex: this.state.dryRunStepIndex },
                moved.fromIndex,
                moved.toIndex
            );
            if (nextDryRun) {
                this.state.dryRunStepIndex = nextDryRun.stepIndex;
                this._emitDryRunState();
            }
        }
    }

    onRecorderDragEnd() {
        this.state.recorderDragStepId = null;
        this.state.recorderDragOverStepId = null;
        this.state.recorderDragOverPosition = null;
    }

    async onRecorderOpenInsertSlot(index) {
        if (this.state.recorderStatus === "idle") return;
        const steps = this.state.recorderSteps || [];
        const clamped = Math.max(0, Math.min(steps.length, Math.floor(Number(index) || 0)));
        if (this.state.recorderInsertAt === clamped && !this.state.recorderInsertCapturing) {
            await this.onRecorderCancelInsert();
            return;
        }
        if (this.state.recorderStatus === "recording") {
            await this.aiRecorder.pauseRecording();
            this.state.recorderStatus = "paused";
        }
        this.state.recorderInsertCapturing = false;
        this.state.recorderInsertAt = clamped;
    }

    async onRecorderCancelInsert() {
        if (this.state.recorderInsertCapturing) {
            await this.aiRecorder?.cancelInsertCapture?.();
            this.state.recorderStatus = "paused";
        }
        this.state.recorderInsertCapturing = false;
        this.state.recorderInsertAt = null;
    }

    onRecorderToggleInsertMulti() {
        this.state.recorderInsertMulti = !this.state.recorderInsertMulti;
    }

    async onRecorderStartLiveInsert() {
        if (!Number.isInteger(this.state.recorderInsertAt)) return;
        if (this.state.dryRunActive) {
            this.onRecorderStopDryRun();
        }
        const targetIndex = this.state.recorderInsertAt;
        this.state.recorderInsertCapturing = true;
        await this.hideSidebar();
        const res = await this.aiRecorder.startInsertCapture({
            index: targetIndex,
            autoStop: !this.state.recorderInsertMulti,
        });
        this.state.recorderSessionId = res.sessionId;
        this.state.recorderStatus = "recording";
        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";
    }

    async onRecorderPickInsertStep() {
        if (!Number.isInteger(this.state.recorderInsertAt) || this.state.recorderPicking) return;
        const targetIndex = this.state.recorderInsertAt;
        this.state.recorderPicking = true;
        await this.hideSidebar();
        document.body.classList.add("o_ai_pick_mode");

        try {
            const picked = await this.aiRecorder.pickTarget({ timeoutMs: 30000 });
            if (!picked) return;

            const stepId =
                picked.draft_step?.id ||
                crypto?.randomUUID?.() ||
                `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            const newStep = picked.draft_step
                ? { ...picked.draft_step, id: stepId }
                : {
                      id: stepId,
                      instruction: buildPickedStepInstruction(picked),
                      is_optional: false,
                      optional_group: null,
                      target: {
                          action: "click",
                          model: this.state.currentContext?.model || null,
                          field: picked?.name || null,
                          target_key: picked?.target_key || null,
                      },
                      ...(picked.nav ? { nav: picked.nav } : {}),
                  };

            const res = insertStepsAt(this.state.recorderSteps || [], [newStep], targetIndex);
            if (res.insertedCount > 0) {
                this.state.recorderSteps = res.steps;
                this.state.recorderStepIndex = Math.max(
                    this.state.recorderStepIndex || 0,
                    this.state.recorderSteps.length
                );
                this.aiRecorder?.syncSessionMeta?.({
                    steps: this.state.recorderSteps,
                    stepIndex: this.state.recorderStepIndex,
                });
                this._reconcileDryRunForInsertion(res.insertedIndex, res.insertedCount);
                this._flashInsertedStep(newStep.id);

                const afterStepId =
                    res.insertedIndex > 0 ? this.state.recorderSteps[res.insertedIndex - 1]?.id || null : null;
                this.aiWs
                    ?.sendEvent?.({
                        type: "exercise_step",
                        event_name: "step_saved",
                        event_data: {
                            recorder_session_id: this.state.recorderSessionId,
                            step_id: newStep.id,
                            step_index: res.insertedIndex + 1,
                            insert_index: res.insertedIndex,
                            after_step_id: afterStepId,
                            timestamp: new Date().toISOString(),
                            instruction: newStep.instruction || "",
                            target: newStep.target?.target_key || picked?.target_key || null,
                            target_meta: picked,
                            context: this.state.currentContext || null,
                        },
                    })
                    .catch(() => {});

                if (this.state.recorderInsertMulti) {
                    this.state.recorderInsertAt = Math.min(
                        this.state.recorderSteps.length,
                        res.insertedIndex + 1
                    );
                } else {
                    this.state.recorderInsertAt = null;
                }
                this.notification.add(
                    _t("Inserted step #%s.", res.insertedIndex + 1),
                    { type: "success" }
                );
            }
        } catch (e) {
            console.warn("[ai_recorder] insert pick failed:", e);
        } finally {
            document.body.classList.remove("o_ai_pick_mode");
            await this.showSidebar();
            this.state.recorderPicking = false;
        }
    }

    async onRecorderGoToPreviousStepScreen() {
        const prevStep = this.recorderInsertPreviousStep;
        if (!prevStep) return;
        await this.onRecorderLocateStep(prevStep);
    }

    isRecorderStepSelected(stepId) {
        return (this.state.selectedRecorderStepIds || []).includes(stepId);
    }

    onRecorderToggleStepSelected(stepId, ev = null) {
        if (!stepId) return;
        const steps = this.state.recorderSteps || [];
        const current = new Set(this.state.selectedRecorderStepIds || []);
        const isChecked = current.has(stepId);

        if (ev?.shiftKey && this._lastSelectedRecorderStepId) {
            const idxA = steps.findIndex((s) => s?.id === this._lastSelectedRecorderStepId);
            const idxB = steps.findIndex((s) => s?.id === stepId);
            if (idxA >= 0 && idxB >= 0) {
                const start = Math.min(idxA, idxB);
                const end = Math.max(idxA, idxB);
                for (let i = start; i <= end; i += 1) {
                    if (steps[i]?.id) {
                        if (isChecked) current.delete(steps[i].id);
                        else current.add(steps[i].id);
                    }
                }
                this.state.selectedRecorderStepIds = Array.from(current);
                this._lastSelectedRecorderStepId = stepId;
                return;
            }
        }

        if (isChecked) {
            current.delete(stepId);
        } else {
            current.add(stepId);
        }
        this.state.selectedRecorderStepIds = Array.from(current);
        this._lastSelectedRecorderStepId = stepId;
    }

    onRecorderSelectAllSteps() {
        const allIds = (this.state.recorderSteps || []).map((s) => s?.id).filter(Boolean);
        const current = this.state.selectedRecorderStepIds || [];
        if (current.length === allIds.length) {
            this.state.selectedRecorderStepIds = [];
        } else {
            this.state.selectedRecorderStepIds = allIds;
        }
    }

    onRecorderClearSelectedSteps() {
        this.state.selectedRecorderStepIds = [];
        this._lastSelectedRecorderStepId = null;
    }

    onRecorderBatchSetOptional(makeOptional) {
        const selectedIds = this.state.selectedRecorderStepIds || [];
        if (!selectedIds.length) return;
        const idSet = new Set(selectedIds);
        this.state.recorderSteps = recomputeOptionalGroups(
            (this.state.recorderSteps || []).map((step) =>
                idSet.has(step.id)
                    ? {
                          ...step,
                          is_optional: !!makeOptional,
                          suggested_optional: makeOptional ? false : step.suggested_optional,
                      }
                    : step
            )
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        this.state.selectedRecorderStepIds = [];
        this._lastSelectedRecorderStepId = null;
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
        this.notification.add(
            makeOptional
                ? _t("Marked %s step(s) as optional.", idSet.size)
                : _t("Marked %s step(s) as required.", idSet.size),
            { type: "success" }
        );
    }

    onRecorderBatchDeleteSelected() {
        const selectedIds = (this.state.selectedRecorderStepIds || []).slice();
        if (!selectedIds.length) return;
        this.onRecorderRemoveStepIds(selectedIds);
        this.state.selectedRecorderStepIds = [];
        this._lastSelectedRecorderStepId = null;
    }

    _scrollToRecorderStep(stepId, { focusInput = false } = {}) {
        if (!stepId) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const root = this.containerRef?.el || document;
                const safeId = window.CSS?.escape ? CSS.escape(stepId) : stepId;
                const card = root.querySelector(`[data-recorder-step-id="${safeId}"]`);
                if (!card) return;
                try {
                    card.scrollIntoView({ behavior: "smooth", block: "center" });
                } catch {}
                if (focusInput) {
                    const input = card.querySelector(".o_ai_rec_step_input");
                    if (input) {
                        input.focus();
                        try {
                            input.select();
                        } catch {}
                    }
                }
            });
        });
    }

    onRecorderToggleStepOptional(stepId) {
        this.state.recorderSteps = recomputeOptionalGroups(
            (this.state.recorderSteps || []).map((step) => {
                if (step.id !== stepId) return step;
                const nextOptional = !step.is_optional;
                return {
                    ...step,
                    is_optional: nextOptional,
                    suggested_optional: nextOptional ? false : step.suggested_optional,
                };
            })
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
    }

    onRecorderAcceptStepOptionalSuggestion(stepId) {
        this.state.recorderSteps = recomputeOptionalGroups(
            (this.state.recorderSteps || []).map((step) =>
                step.id === stepId
                    ? { ...step, is_optional: true, suggested_optional: false }
                    : step
            )
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
    }

    onRecorderDismissStepOptionalSuggestion(stepId) {
        this.state.recorderSteps = (this.state.recorderSteps || []).map((step) =>
            step.id === stepId
                ? { ...step, optional_suggestion_dismissed: true }
                : step
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
    }

    onRecorderAcceptBlockSuggestion(suggestion) {
        if (!suggestion?.stepIds?.length) return;
        const idSet = new Set(suggestion.stepIds);
        this.state.recorderSteps = recomputeOptionalGroups(
            (this.state.recorderSteps || []).map((step) =>
                idSet.has(step.id)
                    ? { ...step, is_optional: true, suggested_optional: false }
                    : step
            )
        );
        this.aiRecorder?.syncSessionMeta?.({ steps: this.state.recorderSteps });
        if (this.state.dryRunActive) {
            this._emitDryRunState();
        }
        this.notification.add(
            _t("Marked steps %s–%s as an optional block.", suggestion.startIndex + 1, suggestion.endIndex + 1),
            { type: "success" }
        );
    }

    onRecorderDismissBlockSuggestion(suggestionId) {
        if (!suggestionId) return;
        const current = this.state.dismissedBlockSuggestionIds || [];
        if (!current.includes(suggestionId)) {
            this.state.dismissedBlockSuggestionIds = [...current, suggestionId];
        }
    }

    _getDryRunPersistState() {
        if (!this.state.dryRunActive) return null;
        return {
            active: true,
            paused: !!this.state.dryRunPaused,
            stepIndex: Math.max(0, Math.floor(Number(this.state.dryRunStepIndex) || 0)),
            editStepId: this.state.dryRunEditStepId || null,
            skippedPromptStepId: this.state.dryRunSkippedPromptStepId || null,
            skippedPromptStepNumber: this.state.dryRunSkippedPromptStepNumber || null,
        };
    }

    _computeDryRunAlreadySatisfied() {
        if (!this.state.dryRunActive) return null;
        return checkDryRunToggleAlreadySatisfied(
            this.state.recorderSteps || [],
            this.state.dryRunStepIndex || 0,
            {
                resolveElement: resolveTargetElement,
                root: document,
            }
        );
    }

    _refreshDryRunAlreadySatisfied() {
        if (!this.state.dryRunActive) {
            this.state.dryRunAlreadySatisfied = null;
            return;
        }
        const next = this._computeDryRunAlreadySatisfied();
        const prev = this.state.dryRunAlreadySatisfied;
        const changed =
            (prev?.stepId || null) !== (next?.stepId || null) ||
            (prev?.satisfied || false) !== (next?.satisfied || false) ||
            (prev?.skipSaveStep || false) !== (next?.skipSaveStep || false) ||
            (prev?.expectedChecked ?? null) !== (next?.expectedChecked ?? null);
        if (changed) {
            this.state.dryRunAlreadySatisfied = next;
            this._emitDryRunState({ persist: false, skipSatisfiedRecalc: true });
        }
    }

    _emitDryRunState({ persist = true, skipSatisfiedRecalc = false } = {}) {
        const steps = this.state.recorderSteps || [];
        const stepIndex = this.state.dryRunStepIndex || 0;
        const step = this.state.dryRunActive && stepIndex < steps.length ? steps[stepIndex] : null;
        const blockRange = step ? getOptionalBlockRange(steps, stepIndex) : null;
        if (!skipSatisfiedRecalc) {
            this.state.dryRunAlreadySatisfied = this._computeDryRunAlreadySatisfied();
        }
        const detail = {
            active: !!this.state.dryRunActive,
            paused: !!this.state.dryRunPaused,
            stepIndex,
            totalSteps: steps.length,
            step: step ? { ...step } : null,
            blockRange,
            alreadySatisfied: this.state.dryRunAlreadySatisfied
                ? { ...this.state.dryRunAlreadySatisfied }
                : null,
            skippedPromptStepId: this.state.dryRunSkippedPromptStepId || null,
            skippedPromptStepNumber: this.state.dryRunSkippedPromptStepNumber || null,
        };
        window[DRY_RUN_STATE_KEY] = detail.active ? detail : null;
        if (persist) {
            this.aiRecorder?.syncSessionMeta?.({ dryRun: this._getDryRunPersistState() });
        }
        window.dispatchEvent(new CustomEvent(DRY_RUN_UPDATE_EVENT, { detail }));
    }

    _attachDryRunListeners() {
        this._detachDryRunListeners();
        this._onDryRunDomClick = (e) => this._handleDryRunDomEvent("click", e);
        this._onDryRunDomChange = (e) => {
            const el = e?.target;
            if (!el || el.type === "checkbox") return;
            const tag = (el.tagName || "").toUpperCase();
            if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
            this._handleDryRunDomEvent("change", e);
        };
        document.addEventListener("click", this._onDryRunDomClick, true);
        document.addEventListener("change", this._onDryRunDomChange, true);
        this._dryRunSatisfiedTimer = setInterval(() => {
            this._refreshDryRunAlreadySatisfied();
        }, 500);
    }

    _detachDryRunListeners() {
        if (this._onDryRunDomClick) {
            document.removeEventListener("click", this._onDryRunDomClick, true);
            this._onDryRunDomClick = null;
        }
        if (this._onDryRunDomChange) {
            document.removeEventListener("change", this._onDryRunDomChange, true);
            this._onDryRunDomChange = null;
        }
        if (this._dryRunSatisfiedTimer) {
            clearInterval(this._dryRunSatisfiedTimer);
            this._dryRunSatisfiedTimer = null;
        }
    }

    _handleDryRunDomEvent(domEventType, e) {
        if (!this.state.dryRunActive || this.state.dryRunPaused) return;
        if (isRecorderUiElement(e?.target)) return;

        const normalized = normalizeDomEvent({
            domEventType,
            originalEvent: e,
            contextService: this.contextService,
        });
        const steps = this.state.recorderSteps || [];
        const match = matchDryRunStepIndex(steps, this.state.dryRunStepIndex, normalized);
        if (!match) return;

        hideTargetHintOverlay();
        this.state.dryRunSkippedPromptStepId = null;
        this.state.dryRunSkippedPromptStepNumber = null;

        if (match.skippedOptionalCount > 0) {
            this.notification.add(
                _t("Skipped %s optional step(s).", match.skippedOptionalCount),
                { type: "info" }
            );
        }

        if (match.nextIndex >= steps.length) {
            this.onRecorderStopDryRun();
            this.notification.add(_t("Dry-Run completed! All steps verified."), { type: "success" });
            return;
        }

        this.state.dryRunStepIndex = match.nextIndex;
        this._emitDryRunState();
    }

    async onRecorderStartDryRun() {
        const steps = this.state.recorderSteps || [];
        if (!steps.length) {
            this.notification.add(_t("Record at least one step before testing."), { type: "warning" });
            return;
        }
        if (this.state.recorderStatus === "recording") {
            await this.onRecorderPause();
        }
        this.state.dryRunActive = true;
        this.state.dryRunPaused = false;
        this.state.dryRunStepIndex = 0;
        this.state.dryRunEditStepId = null;
        this.state.dryRunSkippedPromptStepId = null;
        this.state.dryRunSkippedPromptStepNumber = null;
        this._attachDryRunListeners();
        await this.hideSidebar();
        this._emitDryRunState();
    }

    async onRecorderResumeDryRun() {
        if (!this.state.dryRunActive) return;
        this.state.dryRunPaused = false;
        this.state.dryRunEditStepId = null;
        this._attachDryRunListeners();
        await this.hideSidebar();
        this._emitDryRunState();
    }

    onRecorderStopDryRun() {
        this._detachDryRunListeners();
        hideTargetHintOverlay();
        const wasActive = this.state.dryRunActive;
        this.state.dryRunActive = false;
        this.state.dryRunPaused = false;
        this.state.dryRunStepIndex = 0;
        this.state.dryRunEditStepId = null;
        this.state.dryRunSkippedPromptStepId = null;
        this.state.dryRunSkippedPromptStepNumber = null;
        this.state.dryRunAlreadySatisfied = null;
        if (wasActive) {
            this._emitDryRunState();
        }
    }

    async _handleDryRunAction(detail = {}) {
        if (!this.state.dryRunActive) return;
        const action = detail.action;
        const step = this.dryRunCurrentStep;

        if (action === "locate") {
            if (!step) return;
            const hint = step.target_hint || extractTargetHint({ target: step.target });
            if (this._isSidebarOpen?.()) {
                await this.hideSidebar();
            }
            const shown = hint
                ? showTargetHintOverlay(hint, { caption: step.instruction || hint.actionLabel })
                : false;
            if (!shown) {
                this.notification.add(
                    _t("The target element is not visible on this screen yet."),
                    { type: "info" }
                );
            }
            return;
        }

        if (action === "delete") {
            const targetStepId = detail.stepId || step?.id || null;
            if (targetStepId) {
                this.onRecorderRemoveStepIds([targetStepId], { fromActivePrompt: true });
            }
            return;
        }

        if (action === "continue_satisfied") {
            const satisfied = this._computeDryRunAlreadySatisfied() || this.state.dryRunAlreadySatisfied;
            const steps = this.state.recorderSteps || [];
            const nextIdx = satisfied?.nextIndex ?? (this.state.dryRunStepIndex || 0) + 1;
            hideTargetHintOverlay();
            this.state.dryRunSkippedPromptStepId = null;
            this.state.dryRunSkippedPromptStepNumber = null;
            this.state.dryRunAlreadySatisfied = null;
            if (nextIdx >= steps.length) {
                this.onRecorderStopDryRun();
                this.notification.add(_t("Dry-Run completed! All steps verified."), { type: "success" });
                return;
            }
            this.state.dryRunStepIndex = nextIdx;
            this._emitDryRunState();
            return;
        }

        if (action === "edit") {
            const targetStepId = detail.stepId || step?.id || null;
            this._detachDryRunListeners();
            hideTargetHintOverlay();
            this.state.dryRunPaused = true;
            this.state.dryRunEditStepId = targetStepId;
            this.state.showRecorderPanel = true;
            this.state.recorderReviewTab = false;
            this._emitDryRunState();
            await this.showSidebar();
            this._scrollToRecorderStep(targetStepId, { focusInput: true });
            return;
        }

        if (action === "restart") {
            const steps = this.state.recorderSteps || [];
            if (!steps.length) return;
            hideTargetHintOverlay();
            this.state.dryRunStepIndex = 0;
            this.state.dryRunEditStepId = null;
            this.state.dryRunSkippedPromptStepId = null;
            this.state.dryRunSkippedPromptStepNumber = null;
            this.state.dryRunAlreadySatisfied = null;
            this._emitDryRunState();
            this.notification.add(_t("Dry-Run restarted from step 1."), { type: "info" });
            return;
        }

        if (action === "back") {
            const steps = this.state.recorderSteps || [];
            const currentIdx = this.state.dryRunStepIndex || 0;
            const prevIdx = getPreviousDryRunIndex(steps, currentIdx);
            if (prevIdx === null) return;
            hideTargetHintOverlay();
            this.state.dryRunSkippedPromptStepId = null;
            this.state.dryRunSkippedPromptStepNumber = null;
            this.state.dryRunAlreadySatisfied = null;
            this.state.dryRunStepIndex = prevIdx;
            this._emitDryRunState();
            return;
        }

        if (action === "skip") {
            if (!step) return;
            const steps = this.state.recorderSteps || [];
            const currentIdx = this.state.dryRunStepIndex || 0;
            const nextIdx = getNextIndexAfterSkip(steps, currentIdx);
            hideTargetHintOverlay();
            if (!step.is_optional) {
                this.state.dryRunSkippedPromptStepId = step.id;
                this.state.dryRunSkippedPromptStepNumber = currentIdx + 1;
            } else {
                this.state.dryRunSkippedPromptStepId = null;
                this.state.dryRunSkippedPromptStepNumber = null;
            }
            if (nextIdx >= steps.length) {
                this.onRecorderStopDryRun();
                this.notification.add(_t("Dry-Run reached the end of the exercise."), {
                    type: "info",
                });
                return;
            }
            this.state.dryRunStepIndex = nextIdx;
            this._emitDryRunState();
            return;
        }

        if (action === "toggle_optional") {
            const targetStepId = detail.stepId || step?.id;
            if (targetStepId) {
                this.onRecorderToggleStepOptional(targetStepId);
            }
            return;
        }

        if (action === "mark_skipped_optional") {
            const targetStepId = detail.stepId || this.state.dryRunSkippedPromptStepId;
            if (targetStepId) {
                this.onRecorderAcceptStepOptionalSuggestion(targetStepId);
                this.state.dryRunSkippedPromptStepId = null;
                this.state.dryRunSkippedPromptStepNumber = null;
                this._emitDryRunState();
                this.notification.add(_t("Marked step as optional."), { type: "success" });
            }
            return;
        }

        if (action === "dismiss_skipped_prompt") {
            this.state.dryRunSkippedPromptStepId = null;
            this.state.dryRunSkippedPromptStepNumber = null;
            this._emitDryRunState();
            return;
        }

        if (action === "stop") {
            this.onRecorderStopDryRun();
        }
    }

    onChatDryRunLocate() {
        this._handleDryRunAction({ action: "locate" });
    }

    onChatDryRunEdit() {
        this._handleDryRunAction({ action: "edit", stepId: this.dryRunCurrentStep?.id || null });
    }

    onChatDryRunRestart() {
        this._handleDryRunAction({ action: "restart" });
    }

    onChatDryRunBack() {
        this._handleDryRunAction({ action: "back" });
    }

    onChatDryRunSkip() {
        this._handleDryRunAction({ action: "skip" });
    }

    onChatDryRunDelete() {
        this._handleDryRunAction({ action: "delete", stepId: this.dryRunCurrentStep?.id || null });
    }

    onChatDryRunContinueSatisfied() {
        this._handleDryRunAction({ action: "continue_satisfied" });
    }

    onChatDryRunToggleOptional() {
        this._handleDryRunAction({
            action: "toggle_optional",
            stepId: this.dryRunCurrentStep?.id || null,
        });
    }

    async onChatDryRunBackToBubble() {
        if (!this.state.dryRunActive) return;
        this.state.dryRunPaused = false;
        this.state.dryRunEditStepId = null;
        this._attachDryRunListeners();
        await this.hideSidebar();
        this._emitDryRunState();
    }

    async _waitForTargetElement(hint, { timeoutMs = 2600, intervalMs = 100 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            const el = resolveTargetElement(hint, document);
            if (el) return el;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return resolveTargetElement(hint, document);
    }

    async onRecorderLocateStep(step) {
        if (!step || this.state.recorderLocatingStepId) return;

        const hint = step.target_hint || extractTargetHint({ target: step.target });
        if (!hint) {
            this.notification.add(
                _t("No target element information is available for this step."),
                { type: "info" }
            );
            return;
        }

        const caption = (step.instruction || "").trim() || undefined;
        this.state.recorderLocatingStepId = step.id;
        try {
            if (this.state.recorderStatus === "recording") {
                await this.onRecorderPause();
            }

            if (resolveTargetElement(hint, document)) {
                await this.hideSidebar();
                showTargetHintOverlay(hint, { caption });
                return;
            }

            const nav = step.nav || null;
            let redirected = false;

            if (nav?.appId && this.menuService?.selectMenu) {
                const currentAppId = this.menuService?.getCurrentApp?.()?.id;
                if (currentAppId !== nav.appId) {
                    const apps = this.menuService?.getApps?.() || [];
                    const targetApp = apps.find((a) => a?.id === nav.appId);
                    if (targetApp) {
                        try {
                            await this.menuService.selectMenu(targetApp);
                            redirected = true;
                        } catch {}
                    }
                }
            }

            const actionReq = buildStepLocateActionRequest(nav);
            if (actionReq && this.actionService?.doAction) {
                try {
                    await this.actionService.doAction(actionReq);
                    redirected = true;
                } catch {}
            }

            await this.hideSidebar();

            const el = await this._waitForTargetElement(hint, {
                timeoutMs: redirected ? 2800 : 400,
                intervalMs: 100,
            });
            if (el) {
                showTargetHintOverlay(el, { caption });
                return;
            }

            const screenLabel = nav?.breadcrumb || nav?.appName || nav?.resModel || "";
            if (nav?.inModal && screenLabel) {
                this.notification.add(
                    _t("Opened %s — open the dialog/modal to view this element.", screenLabel),
                    { type: "info" }
                );
            } else if (hint.kind === "menu" && screenLabel) {
                this.notification.add(
                    _t("Opened %s — open its parent menu to view \"%s\".", screenLabel, caption || hint.label || ""),
                    { type: "info" }
                );
            } else if (screenLabel) {
                this.notification.add(
                    _t("This element belongs to %s and is not currently visible on screen.", screenLabel),
                    { type: "info" }
                );
            } else {
                this.notification.add(
                    _t("The target element is not visible on this screen yet."),
                    { type: "info" }
                );
            }
        } finally {
            this.state.recorderLocatingStepId = null;
        }
    }

    async onRecorderSaveForReview() {
        if (this.state.recorderSaving) return;
        let draft;
        try {
            draft = buildRecordingDraftPayload({
                recordingId: this.state.recorderSessionId,
                title: this.state.recorderTitle,
                module: this.state.recorderModule,
                steps: this.state.recorderSteps,
            });
        } catch (err) {
            this.notification.add(err?.message || _t("Complete title, app, and steps first."), {
                type: "warning",
            });
            return;
        }

        this.state.recorderSaving = true;
        try {
            let result;
            let supersededOldDraft = null;
            if (this._editingExerciseId) {
                result = await rpc("/ai_chat/exercises/update", {
                    exercise_id: this._editingExerciseId,
                    draft,
                });
            } else {
                result = await rpc("/ai_chat/recording_drafts/save", { draft });
                if (result?.status === 409) {
                    const previousRecordingId = draft.recording_id;
                    const retryDraft = buildRecordingDraftPayload({
                        recordingId:
                            crypto?.randomUUID?.() ||
                            `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
                        title: this.state.recorderTitle,
                        module: this.state.recorderModule,
                        steps: this.state.recorderSteps,
                    });
                    result = await rpc("/ai_chat/recording_drafts/save", { draft: retryDraft });
                    if (!result?.error && previousRecordingId) {
                        supersededOldDraft = {
                            recordingId: previousRecordingId,
                            authorId:
                                this._editingReviewDraft?.recordingId === previousRecordingId
                                    ? this._editingReviewDraft.authorId
                                    : null,
                        };
                    }
                }
            }
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            if (supersededOldDraft && this.state.canReviewRecordings) {
                try {
                    await rpc("/ai_chat/recording_drafts/review_decision", {
                        recording_id: supersededOldDraft.recordingId,
                        decision: "rejected",
                        comment: "Superseded by edited version",
                        author_id: supersededOldDraft.authorId,
                    });
                } catch {}
            }
            this._editingExerciseId = null;
            this._editingReviewDraft = null;
            this.state.reviewDetail = null;
            this.state.reviewComment = "";
            const strippedFields = Array.isArray(result?.stripped_fields)
                ? result.stripped_fields
                : [];
            if (strippedFields.includes("is_optional")) {
                this.notification.add(
                    _t("Saved draft, but the backend does not persist 'Optional' step flags yet."),
                    { type: "warning" }
                );
            }
            this.onRecorderStopDryRun();
            if (this.state.recorderStatus !== "idle") {
                await this.aiRecorder.finishRecording();
            }
            this._polishRequestSeq += 1;
            this.state.recorderPolishing = false;
            this.state.recorderPrePolishSnapshot = null;
            this._editedDuringPolishStepIds = new Set();
            this.state.recorderStatus = "idle";
            this.state.recorderSessionId = null;
            this.state.recorderTitle = "";
            this.state.recorderModule = "";
            this.state.recorderSteps = [];
            this.state.selectedRecorderStepIds = [];
            this._lastSelectedRecorderStepId = null;
            this.state.recorderUndoStack = [];
            this.state.recorderInsertAt = null;
            this.state.recorderInsertCapturing = false;
            this.state.recorderRecentInsertedStepId = null;
            this.state.recorderPicked = null;
            this.state.recorderNote = "";
            this.state.recorderFeed = [];
            this.notification.add(_t("Recording saved for later review."), { type: "success" });
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not save recording draft."),
                { type: "danger" }
            );
        } finally {
            this.state.recorderSaving = false;
        }
    }

    async toggleRecorderReviewTab(showReview) {
        await this.setRecorderTab(showReview ? "review" : "record");
    }

    async setRecorderTab(tab) {
        if (!this.state.canSeeRecorderToggle) return;
        const target =
            tab === "review" && this.state.canReviewRecordings
                ? "review"
                : tab === "exercises"
                  ? "exercises"
                  : "record";
        this.state.recorderTab = target;
        this.state.recorderReviewTab = target === "review";
        if (target === "review") {
            await this.loadReviewQueue();
        } else if (target === "exercises") {
            await this.loadExplorerExercises();
        }
    }

    get explorerModules() {
        return extractExerciseExplorerModules(this.state.explorerExercises || []);
    }

    get filteredExplorerExercises() {
        return filterExercisesForExplorer(this.state.explorerExercises || [], {
            query: this.state.explorerQuery,
            module: this.state.explorerModuleFilter,
            status:
                this.state.explorerScopeFilter === "global"
                    ? ""
                    : this.state.explorerStatusFilter,
            scope: this.state.explorerUsingFallback ? "" : this.state.explorerScopeFilter,
        });
    }

    async onExplorerScopeChange(scope) {
        const nextScope = scope === "global" || scope === "all" ? scope : "tenant";
        if (this.state.explorerScopeFilter === nextScope) return;
        this.state.explorerScopeFilter = nextScope;
        if (nextScope === "global") {
            this.state.explorerStatusFilter = "published";
        }
        this.state.explorerSelectedId = null;
        this.state.explorerDetail = null;
        this.state.explorerConfirmDeleteId = null;
        await this.loadExplorerExercises();
    }

    async onExplorerStatusChange(ev) {
        const nextStatus = ev?.target?.value || "published";
        this.state.explorerStatusFilter = nextStatus;
        this.state.explorerSelectedId = null;
        this.state.explorerDetail = null;
        this.state.explorerConfirmDeleteId = null;
        if (!this.state.explorerUsingFallback) {
            await this.loadExplorerExercises();
        }
    }

    async loadExplorerExercises() {
        if (!this.state.canSeeRecorderToggle) return;
        const seq = (this._explorerLoadSeq = (this._explorerLoadSeq || 0) + 1);
        this.state.explorerLoading = true;
        this.state.explorerConfirmDeleteId = null;
        try {
            const scope = this.state.explorerScopeFilter || "tenant";
            const statusFilter =
                scope === "global"
                    ? "published"
                    : this.state.explorerStatusFilter || "published";
            const params = { scope };
            if (statusFilter === "all") {
                params.status = "all";
            } else if (statusFilter) {
                params.status = statusFilter;
            }
            const result = await rpc("/ai_chat/exercises/list", params);
            if (seq !== this._explorerLoadSeq) return;
            if (result?.ok) {
                const rawItems = Array.isArray(result?.data?.items)
                    ? result.data.items
                    : Array.isArray(result?.data)
                      ? result.data
                      : [];
                this.state.explorerExercises = rawItems
                    .map((item) => normalizeExerciseExplorerItem(item, { source: "exercise" }))
                    .filter(Boolean);
                this.state.explorerUsingFallback = false;
                if (
                    this.state.explorerModuleFilter &&
                    !this.explorerModules.includes(this.state.explorerModuleFilter)
                ) {
                    this.state.explorerModuleFilter = "";
                }
                return;
            }

            // Graceful fallback while backend /exercises endpoint is not deployed yet:
            // list the creator's own drafts (+ pending review queue for reviewers/admins).
            const fallbackItems = [];
            const seen = new Set();
            const addUnique = (raw, source) => {
                const norm = normalizeExerciseExplorerItem(raw, { source });
                if (norm && !seen.has(norm.id)) {
                    seen.add(norm.id);
                    fallbackItems.push(norm);
                }
            };
            const ownDrafts = await rpc("/ai_chat/recording_drafts/list", {});
            if (seq !== this._explorerLoadSeq) return;
            for (const item of ownDrafts?.data?.items || []) {
                addUnique(item, "draft");
            }
            if (this.state.canReviewRecordings) {
                const reviewDrafts = await rpc("/ai_chat/recording_drafts/review_list", {});
                if (seq !== this._explorerLoadSeq) return;
                for (const item of reviewDrafts?.data?.items || []) {
                    addUnique(item, "draft");
                }
            }
            this.state.explorerExercises = fallbackItems;
            this.state.explorerUsingFallback = true;
        } catch (err) {
            if (seq !== this._explorerLoadSeq) return;
            this.notification.add(
                err?.message || _t("Could not load exercises."),
                { type: "danger" }
            );
        } finally {
            if (seq === this._explorerLoadSeq) {
                this.state.explorerLoading = false;
            }
        }
    }

    async inspectExplorerExercise(item) {
        if (!item?.id) return;
        if (this.state.explorerSelectedId === item.id && this.state.explorerDetail) {
            this.state.explorerSelectedId = null;
            this.state.explorerDetail = null;
            this.state.explorerConfirmDeleteId = null;
            return;
        }
        this.state.explorerSelectedId = item.id;
        this.state.explorerConfirmDeleteId = null;
        this.state.explorerDetailLoading = true;
        try {
            if (item.source === "exercise" && !this.state.explorerUsingFallback) {
                const result = await rpc("/ai_chat/exercises/detail", { exercise_id: item.id });
                if (result?.ok && result.data) {
                    const mergedRaw = {
                        scope: item.scope,
                        read_only: item.readOnly,
                        can_edit: item.canEdit,
                        can_delete: item.canDelete,
                        ...result.data,
                    };
                    const norm = normalizeExerciseExplorerItem(mergedRaw, { source: "exercise" });
                    this.state.explorerDetail = norm || item;
                    return;
                }
            } else if (this.state.canReviewRecordings && item.recordingId) {
                const result = await rpc("/ai_chat/recording_drafts/review_detail", {
                    recording_id: item.recordingId,
                    author_id: item.authorId,
                });
                if (result?.ok && result.data) {
                    const norm = normalizeExerciseExplorerItem(result.data, { source: "draft" });
                    this.state.explorerDetail = norm || item;
                    return;
                }
            }
            this.state.explorerDetail = item;
        } catch {
            this.state.explorerDetail = item;
        } finally {
            this.state.explorerDetailLoading = false;
        }
    }

    async editExplorerExercise(item = null) {
        const target = item || this.state.explorerDetail;
        if (!this.state.canSeeRecorderToggle || !target) return;
        if (target.readOnly || !target.canEdit) return;

        let fullItem = target;
        if (!Array.isArray(fullItem.steps) || !fullItem.steps.length) {
            await this.inspectExplorerExercise(target);
            fullItem = this.state.explorerDetail || target;
        }
        if (fullItem.readOnly || !fullItem.canEdit) return;

        const hydrated = hydrateDraftForEditing({
            recording_id: fullItem.recordingId || fullItem.id,
            title: fullItem.title,
            module: fullItem.module,
            steps: fullItem.steps || [],
        });
        if (!hydrated) return;

        this.onRecorderStopDryRun();
        this._polishRequestSeq += 1;
        this.state.recorderPolishing = false;
        this.state.recorderPrePolishSnapshot = null;
        this._editedDuringPolishStepIds = new Set();

        const apps = this.menuService?.getApps?.() || [];
        const selectedApp = findAppForModule(apps, hydrated.module);

        this.aiRecorder.loadDraftSession({
            sessionId: hydrated.recordingId,
            title: hydrated.title,
            module: hydrated.module,
            moduleRootXmlid: selectedApp?.xmlid || null,
            steps: hydrated.steps,
        });

        this.state.recorderStatus = "paused";
        this.state.recorderSessionId = hydrated.recordingId;
        this._editingExerciseId =
            fullItem.source === "exercise" && !this.state.explorerUsingFallback ? fullItem.id : null;
        this._editingReviewDraft =
            fullItem.source === "draft"
                ? { recordingId: hydrated.recordingId, authorId: fullItem.authorId || null }
                : null;
        this.state.recorderTitle = hydrated.title;
        this.state.recorderModule = hydrated.module;
        this.state.recorderSteps = hydrated.steps;
        this.state.selectedRecorderStepIds = [];
        this._lastSelectedRecorderStepId = null;
        this.state.recorderUndoStack = [];
        this.state.recorderInsertAt = null;
        this.state.recorderInsertCapturing = false;
        this.state.recorderRecentInsertedStepId = null;
        this.state.dismissedSuspectKeys = [];
        this.state.dismissedBlockSuggestionIds = [];
        this.state.recorderStepIndex = hydrated.steps.length;
        this.state.recorderPicked = null;
        this.state.recorderNote = "";
        this.state.recorderFeed = [];
        this.state.recorderTab = "record";
        this.state.recorderReviewTab = false;
        this.state.reviewDetail = null;
        this.state.reviewComment = "";

        this.notification.add(
            _t("Loaded exercise into Recorder. Edit steps and save to update it."),
            { type: "info" }
        );
    }

    onExplorerRequestDelete(exerciseId) {
        if (!exerciseId) return;
        const found = (this.state.explorerExercises || []).find((ex) => ex.id === exerciseId);
        if (found && (found.readOnly || !found.canDelete)) return;
        this.state.explorerConfirmDeleteId =
            this.state.explorerConfirmDeleteId === exerciseId ? null : exerciseId;
    }

    async onExplorerConfirmDelete(item) {
        if (!item?.id || item.readOnly || !item.canDelete || this.state.explorerDeletingId) return;
        this.state.explorerDeletingId = item.id;
        try {
            let result;
            if (item.source === "exercise" && !this.state.explorerUsingFallback) {
                result = await rpc("/ai_chat/exercises/delete", { exercise_id: item.id });
            } else if (this.state.canReviewRecordings && item.recordingId) {
                result = await rpc("/ai_chat/recording_drafts/review_decision", {
                    recording_id: item.recordingId,
                    decision: "rejected",
                    comment: "Deleted from Exercises panel",
                    author_id: item.authorId,
                });
            } else {
                this.notification.add(
                    _t("Delete requires the backend /exercises endpoint or reviewer permission."),
                    { type: "warning" }
                );
                return;
            }
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            this.state.explorerExercises = (this.state.explorerExercises || []).filter(
                (ex) => ex.id !== item.id
            );
            if (this.state.explorerSelectedId === item.id) {
                this.state.explorerSelectedId = null;
                this.state.explorerDetail = null;
            }
            this.state.explorerConfirmDeleteId = null;
            this.notification.add(_t("Exercise deleted."), { type: "success" });
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not delete exercise."),
                { type: "danger" }
            );
        } finally {
            this.state.explorerDeletingId = null;
        }
    }

    async loadReviewQueue() {
        if (!this.state.canReviewRecordings) return;
        this.state.reviewLoading = true;
        try {
            const result = await rpc("/ai_chat/recording_drafts/review_list", {
                review_status: "pending_review",
            });
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            const queue = Array.isArray(result?.data) ? result.data : [];
            this.state.reviewQueue = queue;
            const openId = this.state.reviewDetail?.draft?.recording_id;
            if (openId && !queue.some((item) => item.recording_id === openId)) {
                this.state.reviewDetail = null;
                this.state.reviewComment = "";
            }
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not load review queue."),
                { type: "danger" }
            );
        } finally {
            this.state.reviewLoading = false;
        }
    }

    async inspectReviewDraft(recordingId, authorId) {
        if (!this.state.canReviewRecordings) return;
        this.state.reviewLoading = true;
        try {
            const result = await rpc("/ai_chat/recording_drafts/review_detail", {
                recording_id: recordingId,
                author_id: authorId,
            });
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            this.state.reviewDetail = result?.data || null;
            this.state.reviewComment = "";
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not load draft details."),
                { type: "danger" }
            );
        } finally {
            this.state.reviewLoading = false;
        }
    }

    async submitReviewDecision(decision) {
        const detail = this.state.reviewDetail;
        if (!this.state.canReviewRecordings || !detail?.draft?.recording_id) return;
        this.state.reviewLoading = true;
        try {
            const result = await rpc("/ai_chat/recording_drafts/review_decision", {
                recording_id: detail.draft.recording_id,
                author_id: detail.author_id,
                decision,
                comment: (this.state.reviewComment || "").trim() || null,
            });
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            if (decision === "approved") {
                const publishStatus = String(result?.data?.publish_status || "").trim();
                const publishError = String(result?.data?.publish_error || "").trim() || null;
                if (publishStatus === "chroma_failed" || publishStatus === "publish_failed") {
                    this.state.reviewPublishFailure = {
                        recording_id: detail.draft.recording_id,
                        author_id: detail.author_id,
                        title: detail.draft.title || detail.draft.recording_id,
                        publish_status: publishStatus,
                        publish_error: publishError,
                    };
                    this.notification.add(
                        publishStatus === "chroma_failed"
                            ? _t(
                                  "Exercise approved, but search indexing failed. Click Retry Publish to index it for learners."
                              )
                            : _t(
                                  "Exercise approved, but publishing failed. Click Retry Publish to try again."
                              ),
                        { type: "warning" }
                    );
                } else {
                    if (
                        this.state.reviewPublishFailure?.recording_id ===
                        detail.draft.recording_id
                    ) {
                        this.state.reviewPublishFailure = null;
                    }
                    this.notification.add(_t("Exercise approved for same-tenant learners."), {
                        type: "success",
                    });
                }
            } else {
                if (this.state.reviewPublishFailure?.recording_id === detail.draft.recording_id) {
                    this.state.reviewPublishFailure = null;
                }
                this.notification.add(_t("Exercise rejected."), { type: "success" });
            }
            this.state.reviewDetail = null;
            this.state.reviewComment = "";
            await this.loadReviewQueue();
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not submit review decision."),
                { type: "danger" }
            );
        } finally {
            this.state.reviewLoading = false;
        }
    }

    dismissReviewPublishFailure() {
        this.state.reviewPublishFailure = null;
    }

    onRecorderTitleInput(ev) {
        this.state.recorderTitle = ev.target.value;
        if (this.state.recorderStatus !== "idle") {
            this.aiRecorder?.syncSessionMeta?.({ title: this.state.recorderTitle });
        }
    }

    onRecorderModuleChange(ev) {
        this.state.recorderModule = ev.target.value;
        if (this.state.recorderStatus !== "idle") {
            const apps = this.menuService?.getApps?.() || [];
            const selectedApp = findAppForModule(apps, this.state.recorderModule);
            this.aiRecorder?.syncSessionMeta?.({
                module: this.state.recorderModule,
                moduleRootXmlid: selectedApp?.xmlid || null,
            });
        }
    }

    editReviewDraft(detail = null) {
        const targetDetail = detail || this.state.reviewDetail;
        if (!this.state.canSeeRecorderToggle || !targetDetail?.draft) return;

        const hydrated = hydrateDraftForEditing(targetDetail.draft);
        if (!hydrated) return;

        this.onRecorderStopDryRun();
        this._polishRequestSeq += 1;
        this.state.recorderPolishing = false;
        this.state.recorderPrePolishSnapshot = null;
        this._editedDuringPolishStepIds = new Set();

        const apps = this.menuService?.getApps?.() || [];
        const selectedApp = findAppForModule(apps, hydrated.module);

        this.aiRecorder.loadDraftSession({
            sessionId: hydrated.recordingId,
            title: hydrated.title,
            module: hydrated.module,
            moduleRootXmlid: selectedApp?.xmlid || null,
            steps: hydrated.steps,
        });

        this.state.recorderStatus = "paused";
        this.state.recorderSessionId = hydrated.recordingId;
        this._editingReviewDraft = {
            recordingId: hydrated.recordingId,
            authorId: targetDetail.author_id || null,
        };
        this.state.recorderTitle = hydrated.title;
        this.state.recorderModule = hydrated.module;
        this.state.recorderSteps = hydrated.steps;
        this.state.selectedRecorderStepIds = [];
        this._lastSelectedRecorderStepId = null;
        this.state.recorderUndoStack = [];
        this.state.recorderInsertAt = null;
        this.state.recorderInsertCapturing = false;
        this.state.recorderRecentInsertedStepId = null;
        this.state.dismissedSuspectKeys = [];
        this.state.dismissedBlockSuggestionIds = [];
        this.state.recorderStepIndex = hydrated.steps.length;
        this.state.recorderPicked = null;
        this.state.recorderNote = "";
        this.state.recorderFeed = [];
        this.state.recorderTab = "record";
        this.state.recorderReviewTab = false;
        this.state.reviewDetail = null;
        this.state.reviewComment = "";

        this.notification.add(
            _t("Loaded recording into Recorder. Edit steps and click Save for later review to update it."),
            { type: "info" }
        );
    }

    async retryReviewPublish(target = null) {
        const failure = target || this.state.reviewPublishFailure;
        if (!this.state.canReviewRecordings || !failure?.recording_id) return;
        this.state.reviewLoading = true;
        try {
            const result = await rpc("/ai_chat/recording_drafts/review_publish", {
                recording_id: failure.recording_id,
                author_id: failure.author_id,
            });
            if (result?.error) {
                this.notification.add(result.error, { type: "danger" });
                return;
            }
            const publishStatus = String(result?.data?.publish_status || "").trim();
            const publishError = String(result?.data?.publish_error || "").trim() || null;
            if (publishStatus === "chroma_failed" || publishStatus === "publish_failed") {
                this.state.reviewPublishFailure = {
                    ...failure,
                    publish_status: publishStatus,
                    publish_error: publishError,
                };
                this.notification.add(
                    publishStatus === "chroma_failed"
                        ? _t("Retry completed, but search indexing still failed.")
                        : _t("Publish retry failed."),
                    { type: "warning" }
                );
                return;
            }
            this.state.reviewPublishFailure = null;
            this.notification.add(_t("Exercise published and indexed for same-tenant learners."), {
                type: "success",
            });
            await this.loadReviewQueue();
        } catch (err) {
            this.notification.add(
                err?.message || _t("Could not retry exercise publishing."),
                { type: "danger" }
            );
        } finally {
            this.state.reviewLoading = false;
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
            const builtStep = picked?.draft_step
                ? {
                      ...picked.draft_step,
                      id: stepId,
                      instruction: instruction || picked.draft_step.instruction || buildPickedStepInstruction(picked),
                  }
                : {
                      id: stepId,
                      instruction: instruction || buildPickedStepInstruction(picked),
                      is_optional: false,
                      optional_group: null,
                      target: {
                          action: "click",
                          model: this.state.currentContext?.model || null,
                          field: picked?.name || null,
                          target_key: picked?.target_key || null,
                      },
                      ...(picked?.nav ? { nav: picked.nav } : {}),
                  };
            const targetInsertIdx = Number.isInteger(this.state.recorderInsertAt)
                ? this.state.recorderInsertAt
                : null;
            const inserted = insertStepsAt(this.state.recorderSteps || [], [builtStep], targetInsertIdx);
            this.state.recorderSteps = inserted.steps;
            if (targetInsertIdx !== null && inserted.insertedCount > 0) {
                this._reconcileDryRunForInsertion(inserted.insertedIndex, inserted.insertedCount);
                this._flashInsertedStep(stepId);
                this.state.recorderInsertAt = this.state.recorderInsertMulti
                    ? Math.min(this.state.recorderSteps.length, inserted.insertedIndex + 1)
                    : null;
            }

            this.state.recorderStepIndex = stepIndex;
            this.state.recorderNote = "";
            this.state.recorderPicked = null;
            this.aiRecorder?.syncSessionMeta?.({
                steps: this.state.recorderSteps,
                feed: this.state.recorderFeed,
                stepIndex: this.state.recorderStepIndex,
                note: this.state.recorderNote,
            });

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
        const stepKey = meta.stepKey || null;
        const key = `${displayText}__${timestamp || ""}__${exerciseId || ""}__${stepKey || ""}`;

        const alreadyQueued = queue.some((item) => item.key === key);
        if (alreadyQueued) return;

        queue.push({
            key,
            text: displayText,
            timestamp: timestamp || new Date().toISOString(),
            exerciseId,
            stepKey,
            allowExercisePromptWhileActive,
        });

        if (queue.length > 50) {
            queue.splice(0, queue.length - 50);
        }
    }

    _flushPendingTutorMessages({ preserveScroll: allowPreserveScroll = true } = {}) {
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

            if (this._isDuplicateAssistantText(displayText, { stepKey: item.stepKey || null })) {
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

            const preserveScroll =
                allowPreserveScroll && this._shouldPreserveScrollForIncomingMessage();
            const inserted = this._pushAssistantMessageToNlux(displayText, {
                exerciseId: item.exerciseId || null,
                allowExercisePromptWhileActive: !!item.allowExercisePromptWhileActive,
                preserveScroll,
            });

            if (inserted) {
                this._lastInjectedTutorText = displayText;
                this._lastInjectedTutorAt = Date.now();
                this._lastInjectedTutorStepKey = item.stepKey || null;
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
    _restoreExerciseFromConnectionInfo(info) {
        if (!info || typeof info !== "object") return;
        if (
            info.is_resumed &&
            info.mode === "exercise_active" &&
            info.exercise_id &&
            !this.state.processActive
        ) {
            const restoredFromStorage = this._restoreActiveExerciseSession();
            if (!restoredFromStorage) {
                this.startProcess(info.exercise_id);
            }
            return;
        }

        // Clear stale local exercise state if the backend session is no longer active.
        if (info.mode && info.mode !== "exercise_active") {
            if (this.state.processActive || this._readStoredActiveExercise()) {
                this.completeProcess();
            }
        }

        if (
            info.is_resumed &&
            info.mode === "awaiting_confirmation" &&
            info.exercise_id &&
            !this.state.processActive
        ) {
            this._pendingConfirmationExerciseId = info.exercise_id;
            this._registerExercisePrompt(info.exercise_id);
            this._scheduleExerciseActionsForLastMessage(info.exercise_id, 80, 1);
        }
    }

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
            if (!ev || typeof ev !== "object") return;

            if (ev.type === "connection_established") {
                this._restoreExerciseFromConnectionInfo(ev);
                return;
            }

            if (ev.kind !== "history") return;

            const payload = ev.data;
            const sessionId = payload?.session_id;
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            if (!sessionId) return;

            if (this._historyRenderedForSessionId === sessionId) {
                this._resolveHistoryReady?.();
                this._resolveHistoryReady = null;
                return;
            }

            this._pendingHistory = { sessionId, messages };
            this._flushPendingHistory();
        };

        this._onHistoryLoadedEvent = (e) =>
            this._onHistoryLoaded({ kind: "history", data: e?.detail });

        try {
            this.aiWs?.subscribe?.(this._onHistoryLoaded);
            this._historySubscribed = true;
        } catch (e) {
            console.warn("[AiSidebar] history subscribe failed:", e);
        }
        window.addEventListener("ai:history_loaded", this._onHistoryLoadedEvent);

        const cachedConn = this.aiWs?.getLastConnectionInfo?.();
        if (cachedConn) {
            this._restoreExerciseFromConnectionInfo(cachedConn);
        }

        const cachedHistory = this.aiWs?.getLastHistory?.();
        if (cachedHistory?.session_id) {
            this._onHistoryLoaded({ kind: "history", data: cachedHistory });
        }
    }

    _flushPendingHistory() {
        const pending = this._pendingHistory;
        if (!pending || !pending.sessionId) return false;

        const { sessionId, messages } = pending;
        if (this._historyRenderedForSessionId === sessionId) {
            this._pendingHistory = null;
            this._resolveHistoryReady?.();
            this._resolveHistoryReady = null;
            return true;
        }

        if (!Array.isArray(messages) || messages.length === 0) {
            this._historyRenderedForSessionId = sessionId;
            this._pendingHistory = null;
            this._resolveHistoryReady?.();
            this._resolveHistoryReady = null;
            return true;
        }

        const rendered = this._renderHistory(messages);
        if (!rendered) {
            return false;
        }

        this._historyRenderedForSessionId = sessionId;
        this._pendingHistory = null;
        this._resolveHistoryReady?.();
        this._resolveHistoryReady = null;
        if (this._isSidebarOpen() && !this.state.showRecorderPanel) {
            this._scrollToLatestMessageOnOpen?.();
        }
        return true;
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
        if (!root || !Array.isArray(messages) || messages.length === 0) return false;

        this._ensureConversationVisible();

        const segments = root.querySelector(".nlux-chatSegments-container");
        if (!segments) {
            return false;
        }

        const firstExistingNode = segments.firstChild;
        const existingNormalizedTexts = new Set(
            Array.from(
                segments.querySelectorAll(".nlux-comp-chatItem .nlux-markdown-container")
            )
                .map((el) => normalizeAssistantTextForCompare(el?.innerText || el?.textContent || ""))
                .filter(Boolean)
        );

        const fragment = document.createDocumentFragment();
        let addedCount = 0;

        for (const entry of messages) {
            const text = String(entry?.text || "").trim();
            if (!text) continue;
            const normalized = normalizeAssistantTextForCompare(text);
            if (existingNormalizedTexts.has(normalized)) {
                continue;
            }

            const item =
                entry.role === "user"
                    ? this._buildManualSentItem(text)
                    : this._buildManualReceivedItem(text);
            fragment.appendChild(item);
            addedCount += 1;
        }

        if (addedCount > 0) {
            if (firstExistingNode) {
                // Always insert persisted history ABOVE any live NLUX segment that
                // arrived while reconnecting so new messages are never buried.
                segments.insertBefore(fragment, firstExistingNode);
            } else {
                segments.appendChild(fragment);
            }
        }

        if (this._pendingConfirmationExerciseId && !this.state.processActive) {
            const pendingExId = this._pendingConfirmationExerciseId;
            this._pendingConfirmationExerciseId = null;
            this._scheduleExerciseActionsForLastMessage(pendingExId, 40, 1);
        }

        try {
            this._anchorEl = segments.lastElementChild;
            this._startLockToAnchor();
        } catch (_) {}

        requestAnimationFrame(() => {
            this._ensureCopyButtons?.();
            this._installManualSelectionGuard?.();
            this._scrollConversationToBottom?.();
            this._scheduleConversationReadStateSync?.();
            window.dispatchEvent(new Event("resize"));
        });
        return true;
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

            const stepTarget = extractTargetHint(msg);
            const stepKey = `${msg.exercise_id || this.state.exerciseId || ""}:${msg.current_step ?? ""}`;
            if (msg.type === "reinforce_push") {
                if (stepTarget) {
                    this.state.activeStepTarget = stepTarget;
                }
                if (this._reinforceStepKey !== stepKey) {
                    this._reinforceStepKey = stepKey;
                    this._reinforceCount = 0;
                }
                this._reinforceCount += 1;
                const autoTarget = stepTarget || this.state.activeStepTarget;
                if (autoTarget && shouldAutoShowTargetHint({ reinforceCount: this._reinforceCount })) {
                    showTargetHintOverlay(autoTarget);
                }
            } else if (
                msg.type === "instruction_push" ||
                msg.type === "exercise_completed_push" ||
                msg.type === "welcome_push"
            ) {
                this._reinforceStepKey = stepKey;
                this._reinforceCount = 0;
                hideTargetHintOverlay();
                this.state.hintTarget = null;
                this.state.activeStepTarget = msg.type === "instruction_push" ? (stepTarget || null) : null;
            } else if (stepTarget) {
                this.state.activeStepTarget = stepTarget;
            }

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

            if (
                msg.type === "instruction_push" &&
                this._pendingRedirectStepWaiter &&
                !this._pendingRedirectStepWaiter.settled
            ) {
                const expectedExId = this._normalizeExerciseId(
                    this._pendingRedirectStepWaiter.exerciseId
                );
                const incomingExId = this._normalizeExerciseId(
                    msg.exercise_id || this.state.exerciseId
                );
                if (!expectedExId || !incomingExId || expectedExId === incomingExId) {
                    const waiter = this._pendingRedirectStepWaiter;
                    this._pendingRedirectStepWaiter = null;
                    clearTimeout(waiter.timer);
                    waiter.settled = true;
                    waiter.resolve({ text: displayText, msg });
                    return;
                }
            }

            const allowExercisePromptWhileActive = this._isExerciseResumePromptText(cleaned);
            const exerciseId = this._registerExercisePrompt(this._extractExerciseId(msg), {
                allowWhileActive: allowExercisePromptWhileActive,
            });
            const isWelcomePrompt = this._isWelcomePromptPayload(msg);

            if (exerciseId && isWelcomePrompt) {
                this._pauseExerciseTimer({ reason: "welcome" });
            }

            if (isExerciseCompleted) {
                this.completeProcess({
                    preservePreview: true,
                    completedMessage: cleaned || "",
                });
            }

            const normalized = normalizeAssistantTextForCompare(cleaned);

            console.log("[AI SIDEBAR tutor_push]", {
                type: msg.type,
                cleaned,
                normalized,
                chatReady: !!this.aiChat,
                sidebarOpen: this._isSidebarOpen(),
            });

            const tutorStepKey = buildTutorStepKey(msg, exerciseId || this.state.exerciseId);
            if (this._isDuplicateAssistantText(displayText, { stepKey: tutorStepKey })) {
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
                    stepKey: tutorStepKey,
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
                this._lastInjectedTutorStepKey = tutorStepKey;
            } else {
                // Keep the message if insertion fails.
                this._queueTutorMessage(displayText, msg.timestamp, {
                    exerciseId,
                    stepKey: tutorStepKey,
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
                ".ai_feedback_bar, .ai-msg-footer, .ai-copy-btn, .ai_feedback_popover, .ai-exercise-actions, .ai-quota-actions"
            ).forEach((el) => el.remove());

            const md =
                item.querySelector(".nlux-markdown-container") ||
                item.querySelector(".nlux-comp-messageContent") ||
                item.querySelector(".nlux-comp-messageText");

            if (md) {
                delete md.dataset.copyHighlighted;
                md.removeAttribute?.("data-copy-highlighted");
                md.innerHTML = renderInlineMarkdownHtml(text);
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
                body.innerHTML = renderInlineMarkdownHtml(text);
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
            this._syncStepTargetFromPayload(data);
        } catch (error) {
            const isQuotaError = error?.code === "TRIAL_QUOTA_EXHAUSTED";
            data = {
                error: true,
                error_code: isQuotaError ? "TRIAL_QUOTA_EXHAUSTED" : null,
                response: isQuotaError
                    ? _t("Your trial quota has finished. Get a subscription to continue.")
                    : error?.message || String(error),
            };
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
                assistant: { name: "IAbot", avatar: "/odoo_mentor/static/images/iabotv2.png", tagline: "Your helpful AI assistant!" },
                user: { name: user.name, avatar: userAvatar },
            })
            .withMessageOptions({ waitTimeBeforeStreamCompletion: "never" });

        this._removeManualSelectionGuard?.();

        this.aiChat.mount(this.chatUiRef.el);

        this._waitAndInitAntiAutoScroll();
        this._initFeedbackObserver();

        requestAnimationFrame(() => {
            this._flushPendingHistory?.();
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
        this._pendingHistory = null;
        this._historyRenderedForSessionId = null;
        this._resolveHistoryReady?.();
        this._resolveHistoryReady = null;
        this._historyReadyPromise = null;
        this._lastInjectedTutorText = null;
        this._lastInjectedTutorAt = 0;
        this._lastInjectedTutorStepKey = null;
        this._clearStoredActiveExercise();
        this._cancelPendingExerciseActions();
        this._cancelRedirectStepWaiter();
        this._clearTargetHintState?.();
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
            await this.aiWs.restart({ reason: "ui_reset", clearSession: true, newSession: true });
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
            const rawPayload = response.raw || response;
            const navTarget = extractNavigateToModule(rawPayload);
            const rawMode = String(rawPayload?.mode || "").trim().toLowerCase();
            const navExerciseId = this._normalizeExerciseId(
                rawPayload?.exercise_id || response.result.exercise_id
            );

            if (
                navTarget &&
                navExerciseId &&
                (rawMode === "module_gate" || rawMode === "exercise_active")
            ) {
                if (!this.state.processActive) {
                    this.startProcess(navExerciseId);
                } else {
                    this.state.exerciseId = navExerciseId;
                    this.state.showButtons = false;
                }
            }

            if (navTarget && rawMode === "module_gate") {
                const stepPushPromise = this._waitForRedirectInstructionPush(navExerciseId, 2200);
                const redirected = await this._autoNavigateToExerciseModule(rawPayload);
                if (shouldSuppressModuleGatePrompt(rawPayload, redirected)) {
                    const stepPush = await stepPushPromise;
                    this._cancelRedirectStepWaiter();
                    if (stepPush?.text) {
                        return new String(stepPush.text);
                    }
                    return new String(_t("Opening the required app..."));
                }
                this._cancelRedirectStepWaiter();
            } else if (navTarget) {
                await this._autoNavigateToExerciseModule(rawPayload);
            }

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

            if (response.raw?.error_code === "TRIAL_QUOTA_EXHAUSTED") {
                setTimeout(
                    () => this._scheduleQuotaActionsForLastMessage(receivedCountBefore + 1),
                    0
                );
            }

            if (isExerciseCompleted) {
                this.completeProcess({
                    preservePreview: true,
                    completedMessage: messageText || "",
                });
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
        this._cancelRedirectStepWaiter();
        this._clearTargetHintState?.();
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseId = null;
        this.state.exerciseCancelLoading = false;
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
    }

    completeProcess({ preservePreview = false, completedMessage = "" } = {}) {
        if (this.state.timerInterval) {
            clearInterval(this.state.timerInterval);
        }

        this._timerStartedAtMs = null;
        this._clearStoredActiveExercise();
        this._cancelPendingExerciseActions();
        this._cancelRedirectStepWaiter();
        this._clearTargetHintState?.();
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.exerciseChoicePending = false;
        this.state.exerciseCancelLoading = false;
        this.state.timerInterval = null;
        this.state.timerPaused = false;
        this.state.timerPausedReason = "";
        this.state.timerSeconds = 0;
        this.state.timerValue = "00:00:00";
        this.state.exerciseId = null;
        this._syncComposerDisabledState();
        if (preservePreview) {
            window.dispatchEvent(
                new CustomEvent("ai:exercise_completed_preview", {
                    detail: {
                        message: completedMessage || _t("Exercise completed! Great job."),
                        timestamp: new Date().toISOString(),
                    },
                })
            );
            return;
        }
        window.__AI_TUTOR_OWL_PREVIEW__ = {
            message: "",
            timestamp: "",
            visible: false,
            completed: false,
        };
        window.dispatchEvent(new CustomEvent("ai:preview_reset"));
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
                this._flushPendingHistory?.();
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

    _scrollToLatestMessageOnOpen() {
        if (this.state.showRecorderPanel) return;
        this._stopLock();
        this._userScrollingUntil = 0;

        if (this._openScrollTimer) {
            clearTimeout(this._openScrollTimer);
            this._openScrollTimer = null;
        }

        const scrollNow = () => {
            if (this.state.showRecorderPanel || !this._isSidebarOpen()) return;
            if (performance.now() < (this._userScrollingUntil || 0)) return;
            this._scrollConversationToBottom({ smooth: false });
        };

        scrollNow();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                scrollNow();
            });
        });
        this._openScrollTimer = setTimeout(() => {
            this._openScrollTimer = null;
            scrollNow();
        }, 160);
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
        if (this._openScrollTimer) {
            clearTimeout(this._openScrollTimer);
            this._openScrollTimer = null;
        }
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
