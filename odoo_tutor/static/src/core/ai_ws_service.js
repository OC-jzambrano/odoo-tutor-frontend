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
  return (
    data.type === "chat_response_complete" ||
    data.status === "complete" ||
    data.done === true
  );
}

/** ✅ NUEVO (mínimo): detectar tutor_push sin tocar tu flujo FIFO */
function isTutorPush(data) {
  return !!(data && typeof data === "object" && data.type === "tutor_push");
}

// ✅ Estado GLOBAL: aunque el archivo se ejecute 2 veces, SOLO hay 1 WS real.
function getState() {
  window.__AI_TUTOR_WS_STATE = window.__AI_TUTOR_WS_STATE || {
    ws: null,
    isConnected: false,
    connectPromise: null,

    // session_id del backend (sale en "connection_established")
    wsSessionId: null,
    wsSessionWaiters: [],

    // cola global
    queue: window.__AI_TUTOR_WS_QUEUE || (window.__AI_TUTOR_WS_QUEUE = []),

    // status global
    status:
      window.__AI_TUTOR_WS_STATUS ||
      (window.__AI_TUTOR_WS_STATUS = { status: "init", at: Date.now() }),

    // FIFO chats
    pendingChats: [],

    // listeners
    listeners: new Set(),

    // contexto: solo guardamos el ÚLTIMO (evita enviar "desfasado")
    pendingContextModel: null,
    lastSentContextModel: null,
    lastSentContextAt: 0,
  };
  return window.__AI_TUTOR_WS_STATE;
}

function setStatus(st, status) {
  st.status = { status, at: Date.now() };
  window.__AI_TUTOR_WS_STATUS = st.status;
}

export const aiWsService = {
  async start(env) {
    // ✅ Singleton real: si ya existe API, reúsala (no más conexiones duplicadas)
    if (window.__AI_TUTOR_WS_API_SINGLETON) {
      return window.__AI_TUTOR_WS_API_SINGLETON;
    }

    const baseUrl = "wss://tutor-backend.odooconcept.com/ws";
    const st = getState();

    function isOpen() {
      return st.ws && st.ws.readyState === WS_OPEN;
    }

    function safeSend(payload) {
      if (isOpen()) {
        console.log("[ai_ws] >>", payload);
        st.ws.send(JSON.stringify(payload));
        return true;
      } else {
        st.queue.push(payload);
        return false;
      }
    }

    function flushQueue() {
      if (!isOpen()) return;
      while (st.queue.length) {
        const payload = st.queue.shift();
        console.log("[ai_ws] >> (flush)", payload);
        st.ws.send(JSON.stringify(payload));
      }
    }

    // ✅ espera el wsSessionId (connection_established)
    function waitWsSessionId(timeoutMs = 2500) {
      if (st.wsSessionId) return Promise.resolve(st.wsSessionId);

      return new Promise((resolve, reject) => {
        let done = false;

        const waiter = (sid) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(sid);
        };

        const t = setTimeout(() => {
          if (done) return;
          done = true;

          // 🔥 evita leak: quita este waiter
          const idx = st.wsSessionWaiters.indexOf(waiter);
          if (idx >= 0) st.wsSessionWaiters.splice(idx, 1);

          reject(new Error("WS session_id not received (timeout)"));
        }, timeoutMs);

        st.wsSessionWaiters.push(waiter);
      });
    }

    // ✅ Bridge global para el resto del front
    window.aiTutorSend = (payload) => {
      const ok = safeSend(payload);
      if (!ok) {
        connect().catch((e) =>
          console.warn("[ai_ws] connect (from aiTutorSend) failed:", e)
        );
      }
      return ok;
    };

    async function connect() {
      // ✅ Si ya hay promesa en progreso, reúsala
      if (st.connectPromise) return st.connectPromise;

      // ✅ Si ya hay socket open o connecting, no crees otro
      if (
        st.ws &&
        (st.ws.readyState === WS_OPEN || st.ws.readyState === WS_CONNECTING)
      ) {
        return true;
      }

      setStatus(st, "connecting");

      const sess = (window.odoo && odoo.session_info) || {};
      const params = new URLSearchParams();

      // ⚠️ NO CAMBIAR tu session_id (este es el de Odoo y va en el querystring)
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

      // ⚠️ IMPORTANTE: reset wsSessionId por conexión nueva
      st.wsSessionId = null;

      st.ws = new WebSocket(fullUrl);

      st.connectPromise = new Promise((resolve, reject) => {
        st.ws.onopen = () => {
          st.isConnected = true;
          setStatus(st, "open");
          console.log("[ai_ws] connected");
          flushQueue();
          resolve(true);
          st.connectPromise = null;
        };

        st.ws.onmessage = (ev) => {
          console.log("[ai_ws] << raw:", ev.data);

          let data = null;
          try {
            data = JSON.parse(ev.data);
          } catch {
            data = ev.data;
          }

          console.log("[ai_ws] <<", data);

          // ✅ Capturar session_id del backend
          if (
            data &&
            typeof data === "object" &&
            data.type === "connection_established" &&
            data.session_id
          ) {
            st.wsSessionId = data.session_id;
            window.__AI_TUTOR_WS_SESSION_ID = data.session_id;
            console.log("[ai_ws] ✅ WS session_id captured:", data.session_id);

            // resolver waiters
            const waiters = st.wsSessionWaiters.splice(0);
            for (const fn of waiters) {
              try {
                fn(data.session_id);
              } catch {}
            }

            // ✅ flush del contexto pendiente (solo el ÚLTIMO)
            if (st.pendingContextModel) {
              const m = st.pendingContextModel;
              st.pendingContextModel = null;

              // 🔥 fuerza envío aunque el dedupe crea que ya lo mandó
              sendLiveContext({ context_model: m, force: true }).catch(() => {});
            }
          }

          /**
           * ✅ NUEVO (mínimo): si llega tutor_push, notifícalo SIEMPRE
           * - Lo mandamos como {kind:"tutor_push", data} para que tu AiSidebar lo consuma fácil
           * - También disparo un CustomEvent por si quieres escucharlo sin subscribe()
           */
          if (isTutorPush(data)) {
            for (const fn of st.listeners) {
              try {
                fn({ kind: "tutor_push", data });
              } catch (e) {
                console.error("[ai_ws] listener error (tutor_push)", e);
              }
            }
            try {
              window.dispatchEvent(new CustomEvent("ai:tutor_push", { detail: data }));
            } catch {}
            return;
          }

          // 1) Resolver chat FIFO
          if (st.pendingChats.length) {
            const entry = st.pendingChats[0];

            if (isChatPartial(data)) {
              entry.lastPartial = data;
              for (const fn of st.listeners) {
                try {
                  fn({ kind: "chat_partial", data });
                } catch {}
              }
              return;
            }

            if (isChatFinal(data)) {
              st.pendingChats.shift();
              clearTimeout(entry.timer);
              entry.resolve(data);
              return;
            }
          }

          // 2) Evento general
          for (const fn of st.listeners) {
            try {
              fn(data);
            } catch (e) {
              console.error("[ai_ws] listener error", e);
            }
          }
        };

        st.ws.onerror = (err) => {
          console.error("[ai_ws] error:", err);
          setStatus(st, "error");
        };

        st.ws.onclose = (ev) => {
          st.isConnected = false;
          setStatus(st, "closed");
          console.warn("[ai_ws] closed:", ev.code, ev.reason);

          // 🔥 resetea el session_id del backend al cerrar
          st.wsSessionId = null;

          st.ws = null;

          while (st.pendingChats.length) {
            const entry = st.pendingChats.shift();
            clearTimeout(entry.timer);
            entry.reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
          }

          st.connectPromise = null;
          reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
        };
      });

      return st.connectPromise;
    }

    async function chat({ message, context = {}, timeoutMs = 30000 }) {
      await connect();
      const payload = { type: "chat", message, context };

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = st.pendingChats.findIndex((x) => x.resolve === resolve);
          if (idx >= 0) st.pendingChats.splice(idx, 1);
          reject(new Error("WS timeout waiting for response"));
        }, timeoutMs);

        st.pendingChats.push({ resolve, reject, timer });
        window.aiTutorSend(payload);
      });
    }

    // ✅ Para tus eventos existentes (step_saved, feedback_event, etc.)
    async function sendEvent({ type, event_name, event_data }) {
      await connect();
      const payload = {
        type,
        event_name,
        event_data: {
          ...event_data,
          timestamp: new Date().toISOString(),
        },
      };
      safeSend(payload);
    }

    // ✅ CONTEXTO (formato correcto + session_id del backend)
    async function sendLiveContext({ context_model, force = false } = {}) {
      if (!context_model) return false;

      const now = Date.now();

      // ✅ dedupe rápido (pero si force=true, saltamos dedupe)
      if (!force) {
        if (
          context_model === st.lastSentContextModel &&
          now - st.lastSentContextAt < 800
        ) {
          return true;
        }
      } else {
        st.lastSentContextModel = null;
        st.lastSentContextAt = 0;
      }

      // ✅ si no hay WS abierto, guardo SOLO el último contexto y conecto
      if (!isOpen()) {
        st.pendingContextModel = context_model;
        connect().catch(() => {});
        return false;
      }

      // ✅ si está abierto pero aún no llegó connection_established, guardo el último
      if (!st.wsSessionId) {
        st.pendingContextModel = context_model;
        return false;
      }

      // ✅ (extra seguro) esperar wsSessionId si por timing todavía no está
      let sid = null;
      try {
        sid = st.wsSessionId || (await waitWsSessionId(2500));
      } catch (e) {
        st.pendingContextModel = context_model;
        return false;
      }

      const payload = {
        type: "live_context",
        session_id: sid,
        context_model,
        timestamp: new Date().toISOString(),
      };

      st.lastSentContextModel = context_model;
      st.lastSentContextAt = now;

      return safeSend(payload);
    }

    async function disconnect({ code = 1000, reason = "client_disconnect" } = {}) {
      const sock = st.ws;
      st.ws = null;
      st.isConnected = false;
      st.wsSessionId = null;
      setStatus(st, "closed");

      while (st.pendingChats.length) {
        const entry = st.pendingChats.shift();
        clearTimeout(entry.timer);
        entry.reject(new Error(`WS disconnected (${code}) ${reason || ""}`));
      }

      try {
        if (
          sock &&
          (sock.readyState === WS_OPEN || sock.readyState === WS_CONNECTING)
        ) {
          sock.close(code, reason);
        }
      } catch (e) {
        console.warn("[ai_ws] disconnect close failed:", e);
      }
    }

    async function restart({ reason = "restart" } = {}) {
      await disconnect({ code: 1000, reason });
      await new Promise((r) => setTimeout(r, 80));
      await connect();
    }

    const api = {
      ensureConnected: connect,
      connect,
      disconnect,
      restart,
      chat,
      sendEvent,
      sendLiveContext, // ✅ NUEVO
      subscribe: (fn) => st.listeners.add(fn),
      unsubscribe: (fn) => st.listeners.delete(fn),
      get connected() {
        return st.isConnected;
      },
      get status() {
        return st.status?.status;
      },
      isOpen,
      get wsSessionId() {
        return st.wsSessionId;
      },
    };

    window.aiWs = api;
    window.__AI_TUTOR_WS_API_SINGLETON = api;
    return api;
  },
};

// ✅ Evita registrar el servicio 2 veces si el archivo se ejecuta duplicado
if (!window.__AI_TUTOR_WS_SERVICE_REGISTERED) {
  window.__AI_TUTOR_WS_SERVICE_REGISTERED = true;
  registry.category("services").add("ai_ws", aiWsService);
}
