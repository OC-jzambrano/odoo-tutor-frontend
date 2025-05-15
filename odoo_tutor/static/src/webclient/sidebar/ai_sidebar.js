/** @odoo-module **/
import {
    Component,
    onMounted,
    onWillUnmount,
    useEffect,
    useRef,
    useState,
} from "@odoo/owl";

import {registry} from "@web/core/registry";
import {cookie} from "@web/core/browser/cookie";
import {useService} from "@web/core/utils/hooks";
import {user} from "@web/core/user";
import {imageUrl} from "@web/core/utils/urls";
import {useMouseListeners} from "../../core/utils";

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
            placeholder: this.modelPlaceholders["default"],
            isChatInitialized: false,
        });

        useEffect(
            (currentContext) => {
                if (!currentContext) return;

                const model = currentContext.model;
                const newPlaceholder =
                    this.modelPlaceholders[model] || this.modelPlaceholders["default"];

                if (!this.state.isChatInitialized) {
                    // Primera inicialización
                    this.state.placeholder = newPlaceholder;
                    this.createAiChat();
                    this.state.isChatInitialized = true;
                } else if (this.state.placeholder !== newPlaceholder) {
                    // Actualización posterior
                    this.state.placeholder = newPlaceholder;
                    this.updateChatPlaceholder(newPlaceholder);
                }
            },
            () => [this.state.currentContext]
        );

        // Intervalo para obtener contexto
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
        });

        const aiBotStreamListener = ({message, stop}) => {
            if (stop && this.onStop) {
                this.onStop();
            } else if (!stop && this.onMessage) {
                this.onMessage(message);
            }
        };
        this.busService = this.env.services.bus_service;
        this.busService.subscribe("ai_bot_stream", aiBotStreamListener);

        onWillUnmount(() => {
            clearInterval(this.contextInterval);
            this.busService.unsubscribe("ai_bot_stream", aiBotStreamListener);
        });

        // #region Mouse Events
        this.onHandleMouseDown = useMouseListeners({
            onMouseDown: this.onMouseDown,
            onMouseMove: this.onMouseMove,
            onMouseUp: this.onMouseUp,
        });
        // #endregion
    }

    updateChatPlaceholder(newPlaceholder) {
        if (this.aiChat && this.aiChat.updateComposerOptions) {
            this.aiChat.updateComposerOptions({
                placeholder: newPlaceholder,
            });
        } else {
            this.createAiChat();
        }
    }

    async sendMessage(message, extras) {
        this.state.isLoading = true;
        try {
            const response = await fetch("/ai_chat/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
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
            ? {
                  streamText: this.streamText.bind(this),
              }
            : {
                  batchText: this.batchText.bind(this),
              };

        const {partnerId, writeDate} = user;
        const userAvatar = imageUrl("res.partner", partnerId, "avatar_256", {
            unique: writeDate,
        });

        const theme = cookie.get("color_scheme");

        this.aiChat = globalThis["@nlux/core"]
            .createAiChat()
            .withAdapter(adapter)
            .withDisplayOptions({
                colorScheme: theme,
            })
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
    }

    reset() {
        this.createAiChat();
    }

    async batchText(message, extras) {
        try {
            const response = await this.sendMessage(message, extras);
            return new String(response.result);
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
        this.reset();
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

registry.category("main_components").add("AiSidebar", {
    Component: AiSidebar,
});
