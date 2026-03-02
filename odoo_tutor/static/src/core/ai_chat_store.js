/** @odoo-module **/

import { registry } from "@web/core/registry";
import { reactive } from "@odoo/owl";

export const aiChatStoreService = {
  start() {
    const state = reactive({
      tutorPushes: [],     // <- aquí pintaremos
      unreadCount: 0,
      isChatOpen: false,
    });

    function markOpen(isOpen) {
      state.isChatOpen = !!isOpen;
      if (state.isChatOpen) state.unreadCount = 0;
    }

    function addTutorPush(push) {
      const item = {
        id: crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        response: String(push?.response || ""),
        exercise_id: push?.exercise_id ?? null,
        current_step: push?.current_step ?? null,
        ts: new Date().toISOString(),
      };

      state.tutorPushes.push(item);

      if (!state.isChatOpen) state.unreadCount += 1;
      return item;
    }

    function clearTutorPushes() {
      state.tutorPushes.splice(0, state.tutorPushes.length);
    }

    return { state, markOpen, addTutorPush, clearTutorPushes };
  },
};

registry.category("services").add("ai_chat_store", aiChatStoreService);
