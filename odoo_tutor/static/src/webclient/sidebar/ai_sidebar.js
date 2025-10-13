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

export class AiSidebar extends Component {
    static template = "ai_chat.AiSidebar";
    static props = {};

    setup() {
        super.setup();
        this.contextService = useService("context_service");

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
        this.aiChatService = useService("ai_chat");

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
        });

        this.onHandleMouseDown = useMouseListeners({
            onMouseDown: this.onMouseDown,
            onMouseMove: this.onMouseMove,
            onMouseUp: this.onMouseUp,
        });
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
        this.state.isLoading = true;
        if (!this.state.processActive) this.state.showButtons = false;

        this._expectingAssistant = true;

        try {
            const response = await fetch("/ai_chat/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    message: message,
                    context: this.state.currentContext,
                    streaming: this.state.isStreamingMode,
                    history: extras.conversationHistory,
                }),
            });

            return await response.json();
        } catch (error) {
            console.error("Error sending message:", error);
            throw error;
        }
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
