/* eslint-disable */
/** @odoo-module **/

import { registry } from "@web/core/registry";

function extractModelFromHash() {
  const hash = window.location.hash || "";
  const s = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(s);

  // Odoo suele usar model=
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
    // ✅ si el archivo se carga dos veces, no dupliques listeners
    if (window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED) {
      return {};
    }
    window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED = true;

    const aiWs = env.services.ai_ws;
    const router = env.services.router;

    let lastKey = null;

    const emit = () => {
      const model = extractModelFromHash();
      if (!model) return;
      const route = getCurrentRouteFromDom();
      const key = `${model}__${route}`;

      if (key === lastKey) return;
      lastKey = key;

      console.log("[ai_ctx] route model:", model, route);
      aiWs?.sendLiveContext?.({ context_model: model, route });
    };

    // 1) al cargar
    setTimeout(emit, 0);
    requestAnimationFrame(() => emit());

    // 2) al navegar
    let remove = null;
    try {
      // en Odoo router.addListener suele devolver función de unsubscribe
      remove = router?.addListener?.(() => emit());
    } catch (e) {
      // fallback: escucha hashchange nativo
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

// ✅ registrar una sola vez
if (!window.__AI_TUTOR_CONTEXT_PUSH_SERVICE_REGISTERED) {
  window.__AI_TUTOR_CONTEXT_PUSH_SERVICE_REGISTERED = true;
  registry.category("services").add("ai_context_push", aiContextPushService);
}
