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

function formatTimeAgo(ts) {
    if (!ts) return "";
    const now = Date.now();
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return "";

    const diffSec = Math.max(0, Math.floor((now - then) / 1000));

    if (diffSec < 10) return "just now";
    if (diffSec < 60) return `${diffSec} seconds ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin === 1) return "1 minute ago";
    if (diffMin < 60) return `${diffMin} minutes ago`;

    const diffHour = Math.floor(diffMin / 60);
    if (diffHour === 1) return "1 hour ago";
    if (diffHour < 24) return `${diffHour} hours ago`;

    const diffDay = Math.floor(diffHour / 24);
    if (diffDay === 1) return "1 day ago";
    return `${diffDay} days ago`;
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

function cleanText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

const TUTOR_ASSISTANT_AVATAR_URL = "/odoo_tutor/static/images/iabotv2.png";

export class AiSidebar extends Component {
    static template = "ai_chat.AiSidebar";
    static props = {};

    setup() {
        super.setup();

        // -------------------------
        // Services
        // -------------------------
        this.contextService = useService("context_service");
        this.notification = useService("notification");
        this.aiWs = useService("ai_ws");
        this.aiRecorder = useService("ai_recorder");

        // -------------------------
        // Refs
        // -------------------------
        this.containerRef = useRef("container");
        this.chatUiRef = useRef("chat-ui");
        this.handleRef = useRef("handle");

        this._offcanvasQueue = Promise.resolve();

        // -------------------------
        // Internal
        // -------------------------
        this._activeFeedbackPopover = null;
        this._feedbackObserver = null;
        this._copyButtonsObserver = null;
        this._composerOverflowInput = null;
        this._composerOverflowHandler = null;

        this._seenTutorPush = new Map(); // key -> timestamp
        this._tutorPushTtlMs = 8000;
        this._lastInjectedTutorText = null;
        this._lastInjectedTutorAt = 0;

        // anti-auto-scroll lock
        this._expectingAssistant = false;
        this._lockActive = false;
        this._lockRaf = null;
        this._anchorEl = null;

        // recorder step dedupe
        this._savedStepHashes = new Set();

        // placeholders per model
        this.modelPlaceholders = {
            "sale.order": "You're creating a Quotation, want help?",
            "account.move": "Need help with this Invoice?",
            "project.task": "What do you need to know about this Task?",
            default: "How can I help you today?",
        };

        // -------------------------
        // State
        // -------------------------
        this.state = useState({
            width: "600px",
            isResizing: false,
            isStreamingMode: false,
            isLoading: false,

            currentContext: null,
            breadcrumbPath: "",
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

        // -------------------------
        // React to context changes
        // -------------------------
        useEffect(
            (currentContext) => {
                if (!currentContext) return;

                const model = currentContext.model;
                const newPlaceholder = this.modelPlaceholders[model] || this.modelPlaceholders.default;

                try {
                    this.aiWs?.sendLiveContext?.({ context_model: model });
                } catch (_) {}

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

            this._clearInlineHintTimers();
            this.state.hintMessage = cleaned;
            this.state.hintTimestamp = timestamp || new Date().toISOString();
            this.state.hintHovered = false;
            this.state.hintExiting = false;
            this.state.hintCycle += 1;
            this.state.hintVisible = true;
            this._scheduleInlineHintAutoHide();
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
        };

        this.closeInlineHint = () => {
            if (!this.state.hintVisible && !this.state.hintExiting) return;

            this._clearInlineHintTimers();

            if (this.state.hintExiting) return;

            this.state.hintExiting = true;
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
            if (!this.state.hintVisible || this.state.hintExiting) return;
            this._scheduleInlineHintAutoHide(2200);
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

        this._scheduleInlineHintAutoHide = (delay = 5600) => {
            this._clearInlineHintTimers();
            this._hintAutoHideTimer = setTimeout(() => {
                if (this.state.hintHovered) return;
                this.closeInlineHint();
            }, delay);
        };

        // -------------------------
        // Lifecycle
        // -------------------------
        onMounted(() => {
            this._setupTutorPushListener();

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
                const newContext = this.contextService.getContext();
                if (!newContext) return;

                if (!this.state.currentContext || JSON.stringify(newContext) !== JSON.stringify(this.state.currentContext)) {
                    this.state.currentContext = newContext;
                }

                const breadcrumbPath = this._getCurrentBreadcrumbPath();
                if (breadcrumbPath !== this.state.breadcrumbPath) {
                    this.state.breadcrumbPath = breadcrumbPath;
                }
            }, 250);

            this.observer = new MutationObserver(() => {
                const root = this.chatUiRef?.el;
                if (!root) return;
                const composer = root.querySelector(".nlux-composer-container");
                if (composer) {
                    this.state.composerWidth = composer.offsetWidth;
                    this.state.composerHeight = composer.offsetHeight;
                }
                this._setupComposerOverflowTracking();
                this._syncComposerOverflowState();
            });

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

            this._onTutorHintEvent = (e) => {
                const data = e?.detail;
                if (!data) return;
                this._onTutorHint({ kind: "tutor_hint", data });
            };

            window.addEventListener("ai:tutor_hint", this._onTutorHintEvent);

            requestAnimationFrame(() => {
                this._startCopyButtonsObserver?.();
                this._installManualSelectionGuard?.();
                this._setupComposerOverflowTracking();
                this._syncComposerOverflowState();
            });
        });

        onWillUnmount(() => {
            const el = this._getOffcanvasEl();
            if (el && this._onShown) el.removeEventListener("shown.bs.offcanvas", this._onShown);
            if (el && this._onHidden) el.removeEventListener("hidden.bs.offcanvas", this._onHidden);

            clearInterval(this.contextInterval);
            this._teardownTutorPushListener();
            this._resetInlineHintState({ clearMessage: true });

            if (this.observer) this.observer.disconnect();
            this.observer = null;

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

            if (this._onTutorHintEvent) {
                window.removeEventListener("ai:tutor_hint", this._onTutorHintEvent);
                this._onTutorHintEvent = null;
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

    // =========================================================
    // COPY BUTTON HELPERS
    // =========================================================

    _getChatContainer() {
        return this.el?.querySelector?.("#chat-ui-container") || document.querySelector("#chat-ui-container");
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
            ".ai-copy-btn, .ai_feedback_btn"
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

    get currentRouteLabel() {
        return this.state.breadcrumbPath || this.currentContextLabel || "";
    }

    get currentContextLabel() {
        const model = this.state.currentContext?.model;
        if (!model) return "";

        const modelLabels = {
            "sale.order": "Sales",
            "account.move": "Accounting",
            "project.task": "Project Tasks",
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

    // =========================================================
    // Helpers for tutor_push
    // =========================================================

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

    // =========================================================
    // Bootstrap Offcanvas helpers
    // =========================================================

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
        if (this._hasManualSelection()) return;

        const composerInput =
            this.chatUiRef?.el?.querySelector(".nlux-composer-container textarea, .nlux-composer-container input");
        if (!composerInput) return;

        requestAnimationFrame(() => {
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

        if (!this.state.showRecorderPanel) {
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        }

        this.state.wsStatus = this.aiWs?.isOpen?.() ? "online" : "offline";

        try {
            const ctx = this.state.currentContext;
            if (ctx?.model) this.aiWs?.sendLiveContext?.({ context_model: ctx.model });
        } catch (_) {}

        this._flushPendingTutorMessages?.();
        if (this.state.hintVisible && this.state.hintMessage && !this.state.hintExiting) {
            this._scheduleInlineHintAutoHide?.();
        }
        this._focusComposerInput();
    }

    _afterHidden() {
        document.body.classList.remove("o_ai_pick_mode");
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
    }

    // =========================================================
    // Recorder / Pick
    // =========================================================

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

    _queueTutorMessage(text, timestamp = null) {
        const cleaned = String(text || "").trim();
        if (!cleaned) return;

        const queue = getTutorPendingQueue();
        const key = `${cleaned}__${timestamp || ""}`;

        const alreadyQueued = queue.some((item) => item.key === key);
        if (alreadyQueued) return;

        queue.push({
            key,
            text: cleaned,
            timestamp: timestamp || new Date().toISOString(),
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

            if (this._isDuplicateAssistantText(cleaned)) {
                continue;
            }

            const inserted = this._pushAssistantMessageToNlux(cleaned);

            if (inserted) {
                this._lastInjectedTutorText = cleaned;
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
        });
    }

    _isSidebarOpen() {
        const el = this._getOffcanvasEl();
        return !!el?.classList?.contains("show");
    }

    // =========================================================
    // WS Tutor Push
    // =========================================================

    _setupTutorPushListener() {
        if (this._tutorPushSubscribed) return;

        this._onTutorPush = (ev) => {
            const msg = ev?.kind ? ev.data : ev;
            if (!msg || typeof msg !== "object") return;

            if (msg.type !== "tutor_push") return;

            const text =
                msg.response ||
                msg.message ||
                msg.content ||
                msg.text ||
                "";

            const cleaned = String(text || "").trim();
            if (!cleaned) return;

            const normalized = normalizeAssistantTextForCompare(cleaned);

            console.log("[AI SIDEBAR tutor_push]", {
                type: msg.type,
                cleaned,
                normalized,
                chatReady: !!this.aiChat,
                sidebarOpen: this._isSidebarOpen(),
            });

            if (this._isDuplicateAssistantText(cleaned)) {
                return;
            }

            // Si el chat aún no está listo o el sidebar está cerrado,
            // se guarda para mostrarlo después.
            if (!this.aiChat || !this._isSidebarOpen()) {
                this._queueTutorMessage(cleaned, msg.timestamp);
                return;
            }

            // Si está abierto, intentamos insertarlo.
            const inserted = this._pushAssistantMessageToNlux(cleaned);

            if (inserted) {
                this._lastInjectedTutorText = cleaned;
                this._lastInjectedTutorAt = Date.now();
            } else {
                // Si falló, no lo perdemos.
                this._queueTutorMessage(cleaned, msg.timestamp);
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

    _pushAssistantMessageToNlux(text) {
        if (!this.aiChat) return false;

        this._ensureConversationVisible();

        // Intento 1: API directa de NLUX
        if (typeof this.aiChat.addMessage === "function") {
            try {
                this.aiChat.addMessage({
                    role: "assistant",
                    content: text,
                });

                requestAnimationFrame(() => {
                    this._ensureCopyButtons?.();
                    this._installManualSelectionGuard?.();
                });

                return true;
            } catch (e) {
                console.warn("[AiSidebar] aiChat.addMessage failed:", e);
            }
        }

        // Intento 2: API alternativa de NLUX
        if (typeof this.aiChat.pushMessage === "function") {
            try {
                this.aiChat.pushMessage({
                    role: "assistant",
                    content: text,
                });

                requestAnimationFrame(() => {
                    this._ensureCopyButtons?.();
                    this._installManualSelectionGuard?.();
                });

                return true;
            } catch (e) {
                console.warn("[AiSidebar] aiChat.pushMessage failed:", e);
            }
        }

        // Intento 3: fallback DOM usando el último mensaje recibido como plantilla
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

            // limpiar elementos añadidos por nosotros
            item.querySelectorAll(
                ".ai_feedback_bar, .ai-msg-footer, .ai-copy-btn, .ai_feedback_popover"
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

        try {
            this._anchorEl = item;
            this._startLockToAnchor();
        } catch {}

        requestAnimationFrame(() => {
            this._ensureCopyButtons?.();
            this._installManualSelectionGuard?.();
            window.dispatchEvent(new Event("resize"));
        });

        return true;
    }

    // =========================================================
    // Chat (NLUX)
    // =========================================================

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
        const theme = cookie.get("color_scheme");

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
            this._focusComposerInput();
        });
    }

    async reset() {
        const pendingQueue = getTutorPendingQueue();
        pendingQueue.splice(0, pendingQueue.length);
        this._lastInjectedTutorText = null;
        this._lastInjectedTutorAt = 0;

        this.createAiChat();

        if (this.state.timerInterval) clearInterval(this.state.timerInterval);
        this.state.isLoading = false;
        this.state.showButtons = false;
        this.state.processActive = false;
        this.state.timerValue = "00:00:00";

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

        try {
            const ctx = this.state.currentContext;
            if (ctx?.model) this.aiWs?.sendLiveContext?.({ context_model: ctx.model });
        } catch (_) {}

        requestAnimationFrame(() => {
            this._startCopyButtonsObserver?.();
            this._focusComposerInput();
        });
    }

    async batchText(message) {
        this._expectingAssistant = true;
        this.state.isLoading = true;

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

    // =========================================================
    // Process UI
    // =========================================================

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

    // =========================================================
    // Anti auto-scroll
    // =========================================================

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

    _stopLock() {
        this._lockActive = false;
        if (this._lockRaf) cancelAnimationFrame(this._lockRaf);
        this._lockRaf = null;
        this._anchorEl = null;
    }

    // =========================================================
    // Feedback
    // =========================================================

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
            })
            .catch((e) => console.warn("[ai_sidebar] feedback send failed:", e));
    }

    // =========================================================
    // Resize
    // =========================================================

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
