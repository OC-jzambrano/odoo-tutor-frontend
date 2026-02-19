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

export const aiContextPushService = {
  start(env) {
    // ✅ si el archivo se carga dos veces, no dupliques listeners
    if (window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED) {
      return {};
    }
    window.__AI_TUTOR_CONTEXT_PUSH_INSTALLED = true;

    const aiWs = env.services.ai_ws;
    const router = env.services.router;

    let lastModel = null;

    const emit = () => {
      const model = extractModelFromHash();
      if (!model) return;

      if (model === lastModel) return;
      lastModel = model;

      console.log("[ai_ctx] route model:", model);
      aiWs?.sendLiveContext?.({ context_model: model });
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
