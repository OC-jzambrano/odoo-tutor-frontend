/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

async function getUserLoginSafe() {
  const sess = (window.odoo && odoo.session_info) || {};
  if (sess.username) return sess.username;
  const info = await rpc("/web/session/get_session_info", {});
  return info?.username || info?.login || null;
}

function isChatPartial(data) {
  if (!data || typeof data !== "object") return false;
  return data.type === "chat_response" || data.status === "processing";
}

function isChatFinal(data) {
  if (!data || typeof data !== "object") return false;
  return data.type === "chat_response_complete" || data.status === "complete" || data.done === true;
}

export const aiWsService = {
  async start(env) {
    const baseUrl = "wss://tutor-backend.odooconcept.com/ws";

    let ws = null;
    let isConnected = false;
    let connectPromise = null;

    // ✅ cola GLOBAL (compartida por todo el front)
    window.__AI_TUTOR_WS_QUEUE = window.__AI_TUTOR_WS_QUEUE || [];
    const queue = window.__AI_TUTOR_WS_QUEUE;

    // ✅ status GLOBAL (para UI/alerts)
    window.__AI_TUTOR_WS_STATUS = window.__AI_TUTOR_WS_STATUS || { status: "init", at: Date.now() };
    const setStatus = (status) => {
      window.__AI_TUTOR_WS_STATUS = { status, at: Date.now() };
    };

    // FIFO de chats pendientes (porque tu backend NO manda request_id)
    const pendingChats = []; // [{ resolve, reject, timer, lastPartial }]

    // listeners para eventos generales
    const listeners = new Set();

    function isOpen() {
      return ws && ws.readyState === WS_OPEN;
    }

    function flushQueue() {
      if (!isOpen()) return;
      while (queue.length) {
        const payload = queue.shift();
        console.log("[ai_ws] >> (flush)", payload);
        ws.send(JSON.stringify(payload));
      }
    }

    function safeSend(payload) {
      if (isOpen()) {
        console.log("[ai_ws] >>", payload);
        ws.send(JSON.stringify(payload));
        return true;
      } else {
        queue.push(payload);
        return false;
      }
    }

    // ✅ BRIDGE GLOBAL: existe siempre, aunque no haya WS aún.
    // - si está open, envía
    // - si no, encola y dispara connect() "best effort"
    window.aiTutorSend = (payload) => {
      const ok = safeSend(payload);
      if (!ok) {
        // intenta conectar sin bloquear
        connect().catch((e) => console.warn("[ai_ws] connect (from aiTutorSend) failed:", e));
      }
      return ok;
    };

    async function connect() {
      // evita conexiones duplicadas
      if (connectPromise) return connectPromise;

      // si ya hay socket open o connecting, no crees otro
      if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) {
        return true;
      }

      setStatus("connecting");

      const sess = (window.odoo && odoo.session_info) || {};
      const params = new URLSearchParams();

      if (sess.session_id) params.set("session_id", sess.session_id);
      if (sess.db) params.set("db", sess.db);

      let login = null;
      try {
        login = await getUserLoginSafe();
      } catch (e) {
        console.warn("[ai_ws] getUserLoginSafe failed:", e);
      }
      params.set("user_login", login || "user_not_found");

      const fullUrl = `${baseUrl}?${params.toString()}`;
      console.log("[ai_ws] connecting:", fullUrl);

      ws = new WebSocket(fullUrl);

      connectPromise = new Promise((resolve, reject) => {
        ws.onopen = () => {
          isConnected = true;
          setStatus("open");
          console.log("[ai_ws] connected");
          flushQueue();
          connectPromise = null;
          resolve(true);
        };

        ws.onmessage = (ev) => {
          console.log("[ai_ws] << raw:", ev.data);

          let data = null;
          try { data = JSON.parse(ev.data); } catch { data = ev.data; }

          console.log("[ai_ws] <<", data);

          // 1) Resolver chat pendiente (parcial no resuelve)
          if (pendingChats.length) {
            const entry = pendingChats[0];

            if (isChatPartial(data)) {
              entry.lastPartial = data;
              // opcional: notificar parcial a listeners si quieres UI “typing”
              for (const fn of listeners) {
                try { fn({ kind: "chat_partial", data }); } catch {}
              }
              return;
            }

            if (isChatFinal(data)) {
              pendingChats.shift();
              clearTimeout(entry.timer);
              entry.resolve(data);
              return;
            }
          }

          // 2) Evento general
          for (const fn of listeners) {
            try { fn(data); } catch (e) { console.error("[ai_ws] listener error", e); }
          }
        };

        ws.onerror = (err) => {
          console.error("[ai_ws] error:", err);
          setStatus("error");
        };

        ws.onclose = (ev) => {
          isConnected = false;
          setStatus("closed");
          console.warn("[ai_ws] closed:", ev.code, ev.reason);
          ws = null;

          while (pendingChats.length) {
            const entry = pendingChats.shift();
            clearTimeout(entry.timer);
            entry.reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
          }

          connectPromise = null;
          reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
        };
      });

      return connectPromise;
    }

    async function chat({ message, context = {}, timeoutMs = 30000 }) {
      await connect();
      const payload = { type: "chat", message, context };

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pendingChats.findIndex((x) => x.resolve === resolve);
          if (idx >= 0) pendingChats.splice(idx, 1);
          reject(new Error("WS timeout waiting for response"));
        }, timeoutMs);

        pendingChats.push({ resolve, reject, timer });
        // 🔥 usa bridge global para que sea el mismo camino siempre
        window.aiTutorSend(payload);
      });
    }

    async function sendEvent({ type, event_name, event_data }) {
        await connect();

        const payload = {
            type,
            event_name,
            event_data: {
                ...event_data,
                timestamp: new Date().toISOString(),
                saved_to_odoo: "false",
                error: "",
                rpc_result: "",
            },
        };

        safeSend(payload);
    }


    const api = {
      ensureConnected: connect,
      chat,
      sendEvent,
      subscribe: (fn) => listeners.add(fn),
      unsubscribe: (fn) => listeners.delete(fn),
      get connected() { return isConnected; },
      get status() { return window.__AI_TUTOR_WS_STATUS?.status; }, // open/connecting/closed/error
      isOpen,
    };

    window.aiWs = api; // debug
    return api;
  },
};

registry.category("services").add("ai_ws", aiWsService);
