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
import { cleanXmlId, extractScreenSignatureFromRuntime } from "./screen_signature";
import { buildRecordOpenedTransitionFromLiveContext } from "./state_transition";
import {
  createAuthTicketFrame,
  isAuthenticatedAck,
  isAuthenticationFailure,
  isTicketResponseValid,
  shouldRetryWithoutStoredSession,
} from "./ws_ticket_protocol";
import { TRIAL_QUOTA_EXHAUSTED_MESSAGE } from "./settings_navigation";

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

// Detect tutor push payloads without altering the FIFO chat queue.
function isTutorPush(data) {
  return !!(data && typeof data === "object" && TUTOR_PUSH_TYPES.has(data.type));
}

function getHttpBaseUrl(wsBaseUrl) {
  try {
    const u = new URL(wsBaseUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = u.pathname.replace(/\/ws\/?$/, "");
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function fetchSessionHistory(httpBaseUrl, sessionId) {
  if (!httpBaseUrl || !sessionId) return [];
  try {
    const data = await rpc(`/ai_chat/session/${encodeURIComponent(sessionId)}/messages`, {});
    if (data?.error) {
      console.warn("[ai_ws] fetchSessionHistory failed:", data.error);
      return [];
    }
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch (e) {
    console.warn("[ai_ws] fetchSessionHistory failed:", e);
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

function readStoredWsSession({ db, userId, databaseId, odooSessionId } = {}) {
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
      data.userId !== (userId || null) ||
      data.databaseId !== (databaseId || null) ||
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

function persistWsSession({ db, userId, databaseId, odooSessionId, wsSessionId }) {
  if (!wsSessionId) return;

  const storage = getBrowserStorage();
  if (!storage) return;

  try {
    storage.setItem(
      WS_SESSION_STORAGE_KEY,
      JSON.stringify({
        db: db || null,
        userId: userId || null,
        databaseId: databaseId || null,
        odooSessionId: odooSessionId || null,
        wsSessionId,
      })
    );
  } catch {}
}

// Keep a single shared WebSocket state even if the module loads twice.
function getState() {
  window.__AI_TUTOR_WS_STATE = window.__AI_TUTOR_WS_STATE || {
    ws: null,
    isConnected: false,
    authenticated: false,
    connectPromise: null,

    // Backend session ID received in connection_established.
    wsSessionId: null,
    wsSessionWaiters: [],
    lastHistory: null,
    lastConnectionInfo: null,

    // Global outbound message queue.
    queue: window.__AI_TUTOR_WS_QUEUE || (window.__AI_TUTOR_WS_QUEUE = []),

    // Global connection status.
    status:
      window.__AI_TUTOR_WS_STATUS ||
      (window.__AI_TUTOR_WS_STATUS = { status: "init", at: Date.now() }),

    // Pending FIFO chat promises.
    pendingChats: [],
    pendingEvents: new Map(),

    // Registered event listeners.
    listeners: new Set(),

    // Store only the latest context to avoid sending stale updates.
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

async function getWsConfig() {
  const config = await rpc("/ai_chat/ws_config", {});
  const wsBaseUrl = String(config?.ws_base_url || "").trim();
  if (!wsBaseUrl) {
    throw new Error("Missing WebSocket URL configuration");
  }
  return {
    wsBaseUrl,
    enableSkipStep: config?.enable_skip_step === true,
  };
}

export const aiWsService = {
  async start(env) {
    // Reuse the existing singleton API to prevent duplicate connections.
    if (window.__AI_TUTOR_WS_API_SINGLETON) {
      return window.__AI_TUTOR_WS_API_SINGLETON;
    }

    const { wsBaseUrl: baseUrl, enableSkipStep } = await getWsConfig();
    const st = getState();
    st.recentEventFingerprints ||= new Map();

    let installedModulesPromise = null;
    async function getInstalledModules() {
      if (!installedModulesPromise) {
        installedModulesPromise = env.services.orm
          .searchRead("ir.module.module", [["state", "=", "installed"]], ["name"])
          .then((modules) =>
            Array.isArray(modules)
              ? modules.map((module) => module.name).filter(Boolean)
              : []
          )
          .catch((error) => {
            console.warn("[ai_ws] Unable to read installed Odoo modules:", error);
            installedModulesPromise = null;
            return [];
          });
      }
      return installedModulesPromise;
    }

    function isOpen() {
      return st.ws && st.ws.readyState === WS_OPEN && st.authenticated;
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

    // Wait for the backend wsSessionId from connection_established.
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

          // Remove timed-out waiter to prevent leaks.
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

    // Expose a global bridge for other frontend modules.
    window.aiTutorSend = (payload) => {
      const ok = safeSend(payload);
      if (!ok) {
        connect().catch((e) =>
          console.warn("[ai_ws] connect (from aiTutorSend) failed:", e)
        );
      }
      return ok;
    };

    function connect(options = {}) {
      if (st.connectPromise) return st.connectPromise;
      const currentAttempt = connectInternal(options);
      st.connectPromise = currentAttempt;
      currentAttempt.then(
        () => {
          if (st.connectPromise === currentAttempt) st.connectPromise = null;
        },
        () => {
          if (st.connectPromise === currentAttempt) st.connectPromise = null;
        }
      );
      return currentAttempt;
    }

    async function connectInternal(options = {}) {
      const newSession = Boolean(options?.newSession);
      const skipStoredSession = Boolean(options?.skipStoredSession) || newSession;

      // Reuse the active socket if already open or connecting.
      if (
        st.ws &&
        (st.ws.readyState === WS_OPEN || st.ws.readyState === WS_CONNECTING)
      ) {
        return true;
      }

      setStatus(st, "connecting");

      // A ticket is single-use and must be fetched for every socket attempt.
      let ticketResponse;
      try {
        ticketResponse = await rpc("/ai_chat/ws_ticket", {});
      } catch (error) {
        setStatus(st, "error");
        throw error;
      }
      if (!isTicketResponseValid(ticketResponse)) {
        setStatus(st, "error");
        throw new Error(ticketResponse?.error || "Unable to obtain a valid WebSocket ticket");
      }

      const sess = (window.odoo && odoo.session_info) || {};
      const params = new URLSearchParams();

      const sessionScope = {
        db: sess.db || null,
        userId: sess.uid || null,
        databaseId: null,
        odooSessionId: sess.session_id || null,
      };

      const restoredSessionId = skipStoredSession ? null : readStoredWsSession(sessionScope);
      if (newSession) {
        params.set("new_session", "1");
        st.lastHistory = null;
        st.lastConnectionInfo = null;
      } else if (restoredSessionId) {
        params.set("session_id", restoredSessionId);
      }

      const queryString = params.toString();
      const fullUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;
      console.log("[ai_ws] connecting");

      // Reset wsSessionId before opening a new connection.
      st.wsSessionId = null;
      st.authenticated = false;

      let ws;
      try {
        ws = new WebSocket(fullUrl);
      } catch (error) {
        setStatus(st, "error");
        throw error;
      }
      st.ws = ws;

      st.connectPromise = new Promise((resolve, reject) => {
        let settled = false;
        let connectionFailed = false;
        const authTimer = setTimeout(() => {
          if (settled || st.ws !== ws) return;
          settled = true;
          connectionFailed = true;
          st.authenticated = false;
          setStatus(st, "error");
          ws.close(4001, "authentication_timeout");
          reject(new Error("WebSocket authentication acknowledgement timed out"));
          st.connectPromise = null;
        }, 10000);

        ws.onopen = () => {
          if (st.ws !== ws) {
            return;
          }
          ws.send(createAuthTicketFrame(ticketResponse.ticket));
        };

        ws.onmessage = (ev) => {
          if (st.ws !== ws) {
            return;
          }
          let data = null;
          try {
            data = JSON.parse(ev.data);
          } catch {
            data = ev.data;
          }

          if (!st.authenticated) {
            if (isAuthenticatedAck(data)) {
              clearTimeout(authTimer);
              settled = true;
              st.authenticated = true;
              st.isConnected = true;
              setStatus(st, "open");
              flushQueue();
              resolve(true);
              st.connectPromise = null;
              return;
            }
            if (isAuthenticationFailure(data)) {
              clearTimeout(authTimer);
              settled = true;
              connectionFailed = true;
              if (restoredSessionId) {
                clearStoredWsSession();
              }
              if (
                restoredSessionId &&
                !skipStoredSession &&
                shouldRetryWithoutStoredSession(data)
              ) {
                st.ws = null;
                st.connectPromise = null;
                try {
                  ws.close(4003, "stale_session_retry");
                } catch {}
                connectInternal({ skipStoredSession: true }).then(resolve, reject);
                return;
              }
              setStatus(st, "error");
              ws.close(4003, "authentication_failed");
              reject(new Error(data.message || "WebSocket authentication failed"));
              st.connectPromise = null;
              return;
            }
            return;
          }

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

          if (
            data?.type === "error" &&
            data?.code === "TRIAL_QUOTA_EXHAUSTED" &&
            st.pendingChats.length
          ) {
            const entry = st.pendingChats.shift();
            clearTimeout(entry.timer);
            const quotaError = new Error(TRIAL_QUOTA_EXHAUSTED_MESSAGE);
            quotaError.code = "TRIAL_QUOTA_EXHAUSTED";
            entry.reject(quotaError);
          }

          // Capture backend session_id on connection establishment.
          if (
            data &&
            typeof data === "object" &&
            data.type === "connection_established" &&
            data.session_id
          ) {
            st.wsSessionId = data.session_id;
            st.lastConnectionInfo = data;
            window.__AI_TUTOR_WS_SESSION_ID = data.session_id;
            persistWsSession({ ...sessionScope, wsSessionId: data.session_id });
            console.log("[ai_ws] ✅ WS session_id captured:", data.session_id);

            // Load persisted history only when resuming an existing backend session.
            const historySessionId = data.session_id;
            const emitHistory = (messages) => {
              if (st.wsSessionId !== historySessionId) return;  // Ignore superseded session.
              st.lastHistory = { session_id: historySessionId, messages };
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
            };

            if (data.is_resumed === true) {
              fetchSessionHistory(getHttpBaseUrl(baseUrl), historySessionId).then(emitHistory);
            } else {
              emitHistory([]);
            }

            // Resolve pending session waiters.
            const waiters = st.wsSessionWaiters.splice(0);
            for (const fn of waiters) {
              try {
                fn(data.session_id);
              } catch {}
            }

            // Flush only the latest pending context update.
            if (st.pendingContextModel) {
              const m = st.pendingContextModel;
              st.pendingContextModel = null;

              // Force delivery regardless of prior deduplication state.
              if (typeof m === "object") {
                sendLiveContext({ ...m, force: true }).catch(() => {});
              } else {
                sendLiveContext({ context_model: m, force: true }).catch(() => {});
              }
            }
          }

          // Always notify subscribers and window listeners on tutor push events.
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

          // Resolve pending FIFO chat requests.
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

          // Broadcast general WebSocket events to subscribers.
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
          connectionFailed = true;
          setStatus(st, "error");
        };

        ws.onclose = (ev) => {
          if (st.ws !== ws) {
            return;
          }
          st.isConnected = false;
          st.authenticated = false;
          clearTimeout(authTimer);
          connectionFailed = connectionFailed || !settled;
          setStatus(st, connectionFailed ? "error" : "closed");
          console.warn("[ai_ws] closed:", ev.code, ev.reason);

          // Reset backend session ID when the socket closes.
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
          if (!settled) {
            settled = true;
            reject(new Error(`WS closed (${ev.code}) ${ev.reason || ""}`));
          }
        };
      });

      return st.connectPromise;
    }

    async function chat({ message, context = {}, timeoutMs = 30000, payloadExtra = {} }) {
      await connect();
      const installed_modules = await getInstalledModules();
      const payload = {
        ...payloadExtra,
        type: "chat",
        message,
        context: { ...context, installed_modules },
      };

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

    // Send structured frontend events such as step_saved or feedback_event.
    async function sendEvent({ type, event_name, event_data, awaitAck = false, timeoutMs = 10000 }) {
      await connect();
      const canonicalData = canonicalizeEvent(event_data);
      const canonicalName = canonicalEventType(event_name || canonicalData?.type);
      if (canonicalName === "context_update") {
        canonicalData.context = {
          ...(canonicalData.context || {}),
          installed_modules: await getInstalledModules(),
        };
      }
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

    // Send live navigation context with the active backend session ID.
    async function sendLiveContext({
      context_model,
      route = null,
      view_type = null,
      action_xml_id = null,
      menu_xml_id = null,
      force = false,
    } = {}) {
      if (!context_model) return false;

      const now = Date.now();
      const contextRoute = cleanText(route) || getCurrentRouteFromDom();
      const runtimeSig =
        !view_type || !action_xml_id || !menu_xml_id
          ? extractScreenSignatureFromRuntime({
              controller: env.services.action?.currentController,
              menuService: env.services.menu,
              contextService: env.services.context_service,
              router: env.services.router,
            })
          : null;
      const cleanViewType = cleanText(view_type) || runtimeSig?.view_type || null;
      const cleanActionXmlId = cleanXmlId(action_xml_id) || runtimeSig?.action_xml_id || null;
      const cleanMenuXmlId = cleanXmlId(menu_xml_id) || runtimeSig?.menu_xml_id || null;
      const pendingPayload = {
        context_model,
        route: contextRoute,
        view_type: cleanViewType,
        action_xml_id: cleanActionXmlId,
        menu_xml_id: cleanMenuXmlId,
      };

      // Deduplicate identical context updates unless forced.
      if (!force) {
        if (
          context_model === st.lastSentContextModel &&
          contextRoute === st.lastSentContextRoute &&
          cleanViewType === (st.lastSentContextViewType ?? null) &&
          cleanActionXmlId === (st.lastSentContextActionXmlId ?? null) &&
          cleanMenuXmlId === (st.lastSentContextMenuXmlId ?? null) &&
          now - st.lastSentContextAt < 800
        ) {
          return true;
        }
      } else {
        st.lastSentContextModel = null;
        st.lastSentContextAt = 0;
      }

      // Cache the latest context and connect if the socket is closed.
      if (!isOpen()) {
        st.pendingContextModel = pendingPayload;
        connect().catch(() => {});
        return false;
      }

      // Cache the latest context until connection_established arrives.
      if (!st.wsSessionId) {
        st.pendingContextModel = pendingPayload;
        return false;
      }

      // Wait briefly for wsSessionId if it is not yet populated.
      let sid = null;
      try {
        sid = st.wsSessionId || (await waitWsSessionId(2500));
      } catch (e) {
        st.pendingContextModel = pendingPayload;
        return false;
      }

      const payload = {
        type: "live_context",
        session_id: sid,
        context_model,
        route: contextRoute || null,
        ...(cleanViewType ? { view_type: cleanViewType } : {}),
        ...(cleanActionXmlId ? { action_xml_id: cleanActionXmlId } : {}),
        ...(cleanMenuXmlId ? { menu_xml_id: cleanMenuXmlId } : {}),
        context: { installed_modules: await getInstalledModules() },
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
      st.lastSentContextViewType = cleanViewType;
      st.lastSentContextActionXmlId = cleanActionXmlId;
      st.lastSentContextMenuXmlId = cleanMenuXmlId;
      st.lastSentContextAt = now;
      st.lastLiveContextState = {
        model: context_model,
        view_type: transition ? "form" : cleanViewType,
        record_name: transition?.to?.record_name || null,
        route: contextRoute || null,
        action_xml_id: cleanActionXmlId,
        menu_xml_id: cleanMenuXmlId,
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
      st.authenticated = false;
      st.wsSessionId = null;
      if (clearSession) {
        st.lastHistory = null;
        st.lastConnectionInfo = null;
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

    async function restart({ reason = "restart", clearSession = false, newSession = false } = {}) {
      await disconnect({ code: 1000, reason, clearSession });
      await new Promise((r) => setTimeout(r, 80));
      await connect({ newSession: Boolean(newSession || clearSession) });
    }

    const api = {
      ensureConnected: connect,
      connect,
      disconnect,
      restart,
      chat,
      sendEvent,
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
      getLastHistory: () => st.lastHistory,
      getLastConnectionInfo: () => st.lastConnectionInfo,
      clearPersistedSession,
    };

    window.aiWs = api;
    window.__AI_TUTOR_WS_API_SINGLETON = api;
    // Start eagerly after login without blocking Odoo startup on network errors.
    connect().catch((error) => {
      console.warn("[ai_ws] Automatic connection failed:", error.message);
    });
    return api;
  },
};

// Register the WebSocket service once.
if (!window.__AI_TUTOR_WS_SERVICE_REGISTERED) {
  window.__AI_TUTOR_WS_SERVICE_REGISTERED = true;
  registry.category("services").add("ai_ws", aiWsService);
}
