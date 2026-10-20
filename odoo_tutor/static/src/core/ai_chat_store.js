/** @odoo-module **/

import { registry } from "@web/core/registry";
import { proxy } from "@odoo/owl";

export const aiChatStoreService = {
  start() {
    const state = proxy({
      // Tutor messages awaiting display.
      tutorPushes: [],
      unreadCount: 0,
      isChatOpen: false,
      isAtBottom: true,
    });

    function markOpen(isOpen) {
      state.isChatOpen = !!isOpen;
      if (state.isChatOpen && state.isAtBottom) {
        markRead();
      }
    }

    function setAtBottom(isAtBottom) {
      state.isAtBottom = !!isAtBottom;
      if (state.isChatOpen && state.isAtBottom) {
        markRead();
      }
    }

    function markRead() {
      state.unreadCount = 0;
    }

    function addTutorPush(push, options = {}) {
      const item = {
        id: crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        response: String(push?.response || push?.message || push?.content || push?.text || ""),
        exercise_id: push?.exercise_id ?? null,
        current_step: push?.current_step ?? null,
        ts: new Date().toISOString(),
      };

      state.tutorPushes.push(item);

      const shouldMarkUnread =
        typeof options.unread === "boolean"
          ? options.unread
          : !state.isChatOpen || !state.isAtBottom;

      if (shouldMarkUnread) {
        state.unreadCount += 1;
      } else if (state.isChatOpen) {
        markRead();
      }

      return item;
    }

    function clearTutorPushes() {
      state.tutorPushes.splice(0, state.tutorPushes.length);
    }

    return { state, markOpen, setAtBottom, markRead, addTutorPush, clearTutorPushes };
  },
};

registry.category("services").add("ai_chat_store", aiChatStoreService);
