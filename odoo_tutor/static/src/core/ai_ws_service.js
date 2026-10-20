/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import {
  canonicalEventEnvelopeType,
  canonicalEventFingerprint,
  canonicalEventType,
  canonicalizeEvent,
} from "./event_types";
import { buildOutcomeState } from "./outcome_state";
import { normalizePersistentRecordId } from "./record_id";
import { buildRecordOpenedTransitionFromLiveContext } from "./state_transition";

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

const TUTOR_PUSH_TYPES = new Set([
  "tutor_push",
  "instruction_push",
  "reinforce_push",
  "exercise_completed_push",
  "welcome_push",
  "drift_checkin_push",
]);

/** Detect tutor_push messages without changing FIFO delivery. */
function isTutorPush(data) {
  return !!(data && typeof data === "object" && TUTOR_PUSH_TYPES.has(data.type));
}

async function fetchSessionHistory(sessionId) {
  if (!sessionId) return [];
  try {
    const data = await rpc("/ai_chat/session_history", { session_id: sessionId });
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch (e) {
    return [];
  }
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

// Keep one shared WebSocket state even if this file is loaded more than once.
function getState() {
  window.__AI_TUTOR_WS_STATE = window.__AI_TUTOR_WS_STATE || {
    ws: null,
    isConnected: false,
    connectPromise: null,

    // Backend session ID received in the connection_established event.
    wsSessionId: null,
    wsSessionWaiters: [],

    // Shared message queue.
    queue: window.__AI_TUTOR_WS_QUEUE || (window.__AI_TUTOR_WS_QUEUE = []),

    // Shared connection status.
    status:
      window.__AI_TUTOR_WS_STATUS ||
      (window.__AI_TUTOR_WS_STATUS = { status: "init", at: Date.now() }),

    // FIFO chat requests.
    pendingChats: [],
    pendingEvents: new Map(),

    // Event listeners.
    listeners: new Set(),

    // Keep only the latest context to avoid sending stale data.
    pendingContextModel: null,
    pendingRecordOpen: null,
    pendingRecordResolutionTimer: null,
    recentEventFingerprints: new Map(),
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

async function getWsConfig(sessionId) {
  const config = await rpc("/ai_chat/ws_config", { session_id: sessionId || null });
  if (config?.error) throw new Error(config.message || "Could not prepare an AI chat session");
  const wsBaseUrl = String(config?.ws_base_url || "").trim();
  const ticket = String(config?.ticket || "").trim();
  if (!wsBaseUrl || !ticket) {
    throw new Error("Missing WebSocket URL or single-use connection ticket");
  }
  return {
    wsBaseUrl,
    ticket,
    enableSkipStep: config?.enable_skip_step === true,
  };
}

export const aiWsService = {
  async start(env) {
    // Reuse the existing API to avoid duplicate connections.
    if (window.__AI_TUTOR_WS_API_SINGLETON) {
      return window.__AI_TUTOR_WS_API_SINGLETON;
    }

    let baseUrl = "";
    let enableSkipStep = false;
    const st = getState();
    st.recentEventFingerprints ||= new Map();

    function isOpen() {
      return st.ws && st.ws.readyState === WS_OPEN;
    }

    function safeSend(payload) {
      if (isOpen()) {
        console.log("[ai_ws] >>", payload?.type || "message");
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
        console.log("[ai_ws] >> (flush)", payload?.type || "message");
        st.ws.send(JSON.stringify(payload));
      }
    }

    // Wait for the wsSessionId from connection_established.
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

          // Remove this waiter to prevent a leak.
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

    // Expose a shared bridge for the rest of the frontend.
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
      // Reuse the in-progress connection promise.
      if (st.connectPromise) return st.connectPromise;

      // Reuse the socket if it is open or connecting.
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

      const restoredSessionId = readStoredWsSession(sessionScope);
      let ticket;
      try {
        const wsConfig = await getWsConfig(restoredSessionId);
        baseUrl = wsConfig.wsBaseUrl;
        ticket = wsConfig.ticket;
        enableSkipStep = wsConfig.enableSkipStep;
      } catch (e) {
        setStatus(st, "error");
        throw e;
      }

      params.set("ticket", ticket);
      if (restoredSessionId) {
        params.set("session_id", restoredSessionId);
      }

      const fullUrl = `${baseUrl}?${params.toString()}`;
      console.log("[ai_ws] connecting to tutor WebSocket");

      // Reset wsSessionId for each new connection.
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

          if (data && typeof data === "object" && data.request_id) {
            const pendingEvent = st.pendingEvents.get(data.request_id);
            if (pendingEvent) {
              st.pendingEvents.delete(data.request_id);
              clearTimeout(pendingEvent.timer);
              if (data.type === "error") {
                pendingEvent.reject(new Error(data.message || "Event failed"));
              } else {
                pendingEvent.resolve(data);
              }
              return;
            }
          }

          // Capture the backend session ID.
          if (
            data &&
            typeof data === "object" &&
            data.type === "connection_established" &&
            data.session_id
          ) {
            st.wsSessionId = data.session_id;
            window.__AI_TUTOR_WS_SESSION_ID = data.session_id;
            persistWsSession({ ...sessionScope, wsSessionId: data.session_id });
            console.log("[ai_ws] WS session_id captured:", data.session_id);

            // Load persisted history from Redis after a page reload.
            const historySessionId = data.session_id;
            fetchSessionHistory(historySessionId).then((messages) => {
              // A newer connection replaced this one.
              if (st.wsSessionId !== historySessionId) return;
              for (const fn of st.listeners) {
                try {
                  fn({ kind: "history", data: { session_id: historySessionId, messages } });
                } catch (e) {
                  console.error("[ai_ws] listener error (history)", e);
                }
              }
              try {
                window.dispatchEvent(
                  new CustomEvent("ai:history_loaded", {
                    detail: { session_id: historySessionId, messages },
                  })
                );
              } catch {}
            });

            // Resolve waiting callers.
            const waiters = st.wsSessionWaiters.splice(0);
            for (const fn of waiters) {
              try {
                fn(data.session_id);
              } catch {}
            }

            // Flush the latest pending context.
            if (st.pendingContextModel) {
              const m = st.pendingContextModel;
              st.pendingContextModel = null;

              // Force delivery even if deduplication reports it was already sent.
              if (typeof m === "object") {
                sendLiveContext({ ...m, force: true }).catch(() => {});
              } else {
                sendLiveContext({ context_model: m, force: true }).catch(() => {});
              }
            }
          }

          /** Notify subscribers of each tutor_push through the shared bridge and a CustomEvent. */
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

          // Resolve the next FIFO chat request.
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

          // Notify general event subscribers.
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

          // Reset the backend session ID when the connection closes.
          st.wsSessionId = null;

          st.ws = null;

          while (st.pendingChats.length) {
            const entry = st.pendingChats.shift();
            clearTimeout(entry.timer);
            entry.reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
          }
          for (const pendingEvent of st.pendingEvents.values()) {
            clearTimeout(pendingEvent.timer);
            pendingEvent.reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
          }
          st.pendingEvents.clear();

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

    // Preserve support for existing events such as step_saved and feedback_event.
    async function sendEvent({ type, event_name, event_data, awaitAck = false, timeoutMs = 10000 }) {
      await connect();
      const canonicalData = canonicalizeEvent(event_data);
      const canonicalName = canonicalEventType(event_name || canonicalData?.type);
      const fingerprint = canonicalEventFingerprint({
        type: canonicalName,
        event_data: canonicalData,
      });
      const eventNow = Date.now();
      const lastSentAt = st.recentEventFingerprints.get(fingerprint) || 0;
      if (eventNow - lastSentAt < 400) {
        if (awaitAck) {
          throw new Error("Duplicate event suppressed");
        }
        return false;
      }
      st.recentEventFingerprints.set(fingerprint, eventNow);
      if (st.recentEventFingerprints.size > 200) {
        for (const [key, sentAt] of st.recentEventFingerprints) {
          if (eventNow - sentAt > 5000) {
            st.recentEventFingerprints.delete(key);
          }
        }
      }

      if (canonicalName === "card_clicked") {
        const meta = canonicalData?.meta || {};
        st.pendingRecordOpen = {
          model: meta.model || null,
          view_type: meta.view_type || meta.viewType || "kanban",
          res_id:
            meta.card_res_id ??
            meta.res_id ??
            meta.resId ??
            null,
          record_name: canonicalData?.label || null,
          clicked_at: Date.now(),
        };
      }

      const outcomeState = buildOutcomeState({
        contextService: env.services.context_service,
        eventData: canonicalData,
      });
      const payload = {
        type: canonicalEventEnvelopeType(type),
        event_name: canonicalName || event_name,
        event_data: {
          ...canonicalData,
          timestamp: new Date().toISOString(),
        },
        outcome_state: outcomeState,
      };
      if (awaitAck) {
        payload.request_id =
          globalThis.crypto?.randomUUID?.() ||
          `event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            st.pendingEvents.delete(payload.request_id);
            reject(new Error("WS timeout waiting for event acknowledgement"));
          }, timeoutMs);
          st.pendingEvents.set(payload.request_id, { resolve, reject, timer });
          try {
            safeSend(payload);
          } catch (error) {
            clearTimeout(timer);
            st.pendingEvents.delete(payload.request_id);
            reject(error);
          }
        });
      }
      safeSend(payload);
      return true;
    }

    // Send context with the expected format and backend session ID.
    async function sendLiveContext({ context_model, route = null, force = false } = {}) {
      if (!context_model) return false;

      const now = Date.now();
      const contextRoute = cleanText(route) || getCurrentRouteFromDom();

      // Skip deduplication when force is true.
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

      // Keep only the latest context and connect when no socket is open.
      if (!isOpen()) {
        st.pendingContextModel = { context_model, route: contextRoute };
        connect().catch(() => {});
        return false;
      }

      // Keep the latest context until connection_established arrives.
      if (!st.wsSessionId) {
        st.pendingContextModel = { context_model, route: contextRoute };
        return false;
      }

      // Wait for wsSessionId if it is not available yet.
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

      const pendingRecordOpen =
        st.pendingRecordOpen &&
        now - st.pendingRecordOpen.clicked_at <= 5000
          ? st.pendingRecordOpen
          : null;
      if (st.pendingRecordOpen && !pendingRecordOpen) {
        st.pendingRecordOpen = null;
      }

      const activeContext = (() => {
        try {
          return env.services.context_service?.getContext?.() || {};
        } catch {
          return {};
        }
      })();
      const activeResId =
        activeContext.model === context_model
          ? normalizePersistentRecordId(
              activeContext.res_id ?? activeContext.resId
            )
          : null;

      if (pendingRecordOpen && !activeResId && !st.pendingRecordResolutionTimer) {
        st.pendingRecordResolutionTimer = setTimeout(() => {
          st.pendingRecordResolutionTimer = null;
          if (
            st.pendingRecordOpen &&
            Date.now() - st.pendingRecordOpen.clicked_at <= 5000
          ) {
            sendLiveContext({
              context_model,
              route: contextRoute,
              force: true,
            }).catch(() => {});
          }
        }, 250);
      }

      const transition =
        pendingRecordOpen && !activeResId
          ? null
          : buildRecordOpenedTransitionFromLiveContext({
              from: st.lastLiveContextState || {
                model: st.lastSentContextModel,
                view_type: null,
              },
              context_model,
              route: contextRoute,
              pending_record: pendingRecordOpen,
              res_id: activeResId,
            });
      const recordOpenedKey = transition
        ? `${contextRoute || ""}|${transition.to.res_id ?? ""}|${transition.to.record_name || ""}`
        : null;

      st.lastSentContextModel = context_model;
      st.lastSentContextRoute = contextRoute;
      st.lastSentContextAt = now;
      st.lastLiveContextState = {
        model: context_model,
        view_type: transition ? "form" : null,
        record_name: transition?.to?.record_name || null,
        route: contextRoute || null,
      };

      if (transition) {
        st.pendingRecordOpen = null;
      }

      if (transition && recordOpenedKey !== st.lastRecordOpenedKey) {
        st.lastRecordOpenedKey = recordOpenedKey;
        sendEvent({
          type: "ui_event",
          event_name: transition.name,
          event_data: transition,
        }).catch(() => {});
      }

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
      for (const pendingEvent of st.pendingEvents.values()) {
        clearTimeout(pendingEvent.timer);
        pendingEvent.reject(new Error(`WS disconnected (${code}) ${reason || ""}`));
      }
      st.pendingEvents.clear();

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
      // Send live Odoo context to the backend.
      sendLiveContext,
      subscribe: (fn) => st.listeners.add(fn),
      unsubscribe: (fn) => st.listeners.delete(fn),
      get connected() {
        return st.isConnected;
      },
      get status() {
        return st.status?.status;
      },
      isOpen,
      enableSkipStep,
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

// Register the service only once if the file is loaded more than once.
if (!window.__AI_TUTOR_WS_SERVICE_REGISTERED) {
  window.__AI_TUTOR_WS_SERVICE_REGISTERED = true;
  registry.category("services").add("ai_ws", aiWsService);
}
