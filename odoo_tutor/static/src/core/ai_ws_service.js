/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_SESSION_STORAGE_KEY = "odoo_tutor.ws_session_info";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getCurrentRouteFromDom() {
  try {
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
  } catch {
    return "";
  }
}

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

function getBrowserStorage() {
  try {
    if (window.localStorage) return window.localStorage;
  } catch {}
  try {
    if (window.sessionStorage) return window.sessionStorage;
  } catch {}
  return null;
}

function clearStoredWsSession() {
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    storage.removeItem(WS_SESSION_STORAGE_KEY);
  } catch {}
}

function readStoredWsSession({ db, userLogin, odooSessionId } = {}) {
  const storage = getBrowserStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(WS_SESSION_STORAGE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      clearStoredWsSession();
      return null;
    }

    if (
      data.db !== (db || null) ||
      data.userLogin !== (userLogin || null) ||
      data.odooSessionId !== (odooSessionId || null) ||
      !data.wsSessionId
    ) {
      clearStoredWsSession();
      return null;
    }

    return data.wsSessionId;
  } catch {
    clearStoredWsSession();
    return null;
  }
}

function persistWsSession({ db, userLogin, odooSessionId, wsSessionId }) {
  if (!wsSessionId) return;

  const storage = getBrowserStorage();
  if (!storage) return;

  try {
    storage.setItem(
      WS_SESSION_STORAGE_KEY,
      JSON.stringify({
        db: db || null,
        userLogin: userLogin || null,
        odooSessionId: odooSessionId || null,
        wsSessionId,
      })
    );
  } catch {}
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
    lastSentContextRoute: null,
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

    function clearPersistedSession() {
      clearStoredWsSession();
      window.__AI_TUTOR_WS_SESSION_ID = null;
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

      let login = null;
      try {
        login = await getUserLoginSafe();
      } catch (e) {
        console.warn("[ai_ws] getUserLoginSafe failed:", e);
      }
      const sessionScope = {
        db: sess.db || null,
        userLogin: login || "user_not_found",
        odooSessionId: sess.session_id || null,
      };

      if (sessionScope.db) params.set("db", sessionScope.db);
      params.set("user_login", sessionScope.userLogin);

      const restoredSessionId = readStoredWsSession(sessionScope);
      if (restoredSessionId) {
        params.set("session_id", restoredSessionId);
      }

      const fullUrl = `${baseUrl}?${params.toString()}`;
      console.log("[ai_ws] connecting:", fullUrl);

      // ⚠️ IMPORTANTE: reset wsSessionId por conexión nueva
      st.wsSessionId = null;

      const ws = new WebSocket(fullUrl);
      st.ws = ws;

      st.connectPromise = new Promise((resolve, reject) => {
        ws.onopen = () => {
          if (st.ws !== ws) {
            return;
          }
          st.isConnected = true;
          setStatus(st, "open");
          console.log("[ai_ws] connected");
          flushQueue();
          resolve(true);
          st.connectPromise = null;
        };

        ws.onmessage = (ev) => {
          if (st.ws !== ws) {
            return;
          }
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
            persistWsSession({ ...sessionScope, wsSessionId: data.session_id });
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
              if (typeof m === "object") {
                sendLiveContext({ ...m, force: true }).catch(() => {});
              } else {
                sendLiveContext({ context_model: m, force: true }).catch(() => {});
              }
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

              for (const fn of st.listeners) {
                try {
                  fn({ kind: "chat_final", data });
                } catch {}
              }
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

        ws.onerror = (err) => {
          if (st.ws !== ws) {
            return;
          }
          console.error("[ai_ws] error:", err);
          setStatus(st, "error");
        };

        ws.onclose = (ev) => {
          if (st.ws !== ws) {
            return;
          }
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

    async function chat({ message, context = {}, timeoutMs = 30000, payloadExtra = {} }) {
      await connect();
      const payload = { ...payloadExtra, type: "chat", message, context };

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
    async function sendLiveContext({ context_model, route = null, force = false } = {}) {
      if (!context_model) return false;

      const now = Date.now();
      const contextRoute = cleanText(route) || getCurrentRouteFromDom();

      // ✅ dedupe rápido (pero si force=true, saltamos dedupe)
      if (!force) {
        if (
          context_model === st.lastSentContextModel &&
          contextRoute === st.lastSentContextRoute &&
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
        st.pendingContextModel = { context_model, route: contextRoute };
        connect().catch(() => {});
        return false;
      }

      // ✅ si está abierto pero aún no llegó connection_established, guardo el último
      if (!st.wsSessionId) {
        st.pendingContextModel = { context_model, route: contextRoute };
        return false;
      }

      // ✅ (extra seguro) esperar wsSessionId si por timing todavía no está
      let sid = null;
      try {
        sid = st.wsSessionId || (await waitWsSessionId(2500));
      } catch (e) {
        st.pendingContextModel = { context_model, route: contextRoute };
        return false;
      }

      const payload = {
        type: "live_context",
        session_id: sid,
        context_model,
        route: contextRoute || null,
        timestamp: new Date().toISOString(),
      };

      st.lastSentContextModel = context_model;
      st.lastSentContextRoute = contextRoute;
      st.lastSentContextAt = now;

      return safeSend(payload);
    }

    async function disconnect({
      code = 1000,
      reason = "client_disconnect",
      clearSession = false,
    } = {}) {
      const sock = st.ws;
      st.ws = null;
      st.isConnected = false;
      st.wsSessionId = null;
      if (clearSession) {
        clearPersistedSession();
      }
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

    async function restart({ reason = "restart", clearSession = false } = {}) {
      await disconnect({ code: 1000, reason, clearSession });
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
      clearPersistedSession,
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
