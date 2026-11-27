/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";
import { extractScreenSignatureFromRuntime } from "./screen_signature";

function extractModelFromHash() {
  const hash = window.location.hash || "";
  const s = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(s);

  // Read the active model parameter from the URL hash.
  return (
    params.get("model") ||
    params.get("active_model") ||
    params.get("res_model") ||
    null
  );
}

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

export const aiContextPushService = {
  start(env) {
    // Prevent duplicate listeners if the module loads twice.
    if (window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED) {
      return {};
    }
    window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED = true;

    const aiWs = env.services.ai_ws;
    const router = env.services.router;
    const actionService = env.services.action;
    const menuService = env.services.menu;
    const contextService = env.services.context_service;

    let lastKey = null;

    const emit = () => {
      const sig = extractScreenSignatureFromRuntime({
        controller: actionService?.currentController,
        menuService,
        contextService,
        router,
      });
      const model = extractModelFromHash() || sig.model;
      if (!model) return;
      const route = getCurrentRouteFromDom();
      const key = `${model}__${route}__${sig.view_type || ""}__${sig.action_xml_id || ""}__${sig.menu_xml_id || ""}`;

      if (key === lastKey) return;
      lastKey = key;

      console.log("[ai_ctx] route model:", model, route);
      aiWs?.sendLiveContext?.({
        context_model: model,
        route,
        view_type: sig.view_type,
        action_xml_id: sig.action_xml_id,
        menu_xml_id: sig.menu_xml_id,
      });
    };

    // Emit initial context on load.
    setTimeout(emit, 0);
    requestAnimationFrame(() => emit());

    // Emit context on route navigation.
    let remove = null;
    try {
      // Subscribe to Odoo router changes.
      remove = router?.addListener?.(() => emit());
    } catch (e) {
      // Fall back to native hashchange events.
      window.addEventListener("hashchange", emit, true);
      remove = () => window.removeEventListener("hashchange", emit, true);
    }

    return {
      stop() {
        try { remove && remove(); } catch {}
      },
    };
  },
};

// Register the service once.
if (!window.__AI_TUTOR_CONTEXT_PUSH_SERVICE_REGISTERED) {
  window.__AI_TUTOR_CONTEXT_PUSH_SERVICE_REGISTERED = true;
  registry.category("services").add("ai_context_push", aiContextPushService);
}
