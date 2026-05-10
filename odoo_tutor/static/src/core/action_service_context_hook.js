/* eslint-disable */
/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { actionService } from "@web/webclient/actions/action_service";

function extractModelFromActionRequest(req) {
  if (!req) return null;
  if (typeof req === "object") {
    return (
      req.res_model ||
      req.model ||
      req.context?.active_model ||
      req.context?.default_model ||
      null
    );
  }
  return null;
}

function extractModelFromController(ctrl) {
  if (!ctrl) return null;
  return (
    ctrl?.props?.resModel ||
    ctrl?.action?.res_model ||
    ctrl?.model?.root?.resModel ||
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

patch(actionService, {
  start(env) {
    const res = super.start(env);
    const aiWs = env.services.ai_ws;

    const send = (model, opts = {}) => {
      if (!model) return;
      const route = getCurrentRouteFromDom();
      console.log("[ai_ctx] live_context ->", model, route, opts?.reason || "");
      aiWs?.sendLiveContext?.({ context_model: model, route, force: !!opts.force });
    };

    // ---------
    // ✅ BOOT PROBE: al recargar, a veces currentController tarda en existir
    // ---------
    const bootProbe = () => {
      const maxMs = 3000;
      const stepMs = 120;
      const start = Date.now();

      const tick = () => {
        const model = extractModelFromController(res.currentController);
        if (model) {
          send(model, { reason: "boot", force: true });
          return;
        }
        if (Date.now() - start < maxMs) {
          setTimeout(tick, stepMs);
        }
      };

      // 1er intento próximo frame + reintentos
      requestAnimationFrame(() => setTimeout(tick, 0));
    };

    bootProbe();

    // ---------
    // ✅ doAction override IN-PLACE (sin spread)
    // ---------
    const _superDoAction = res.doAction.bind(res);

    res.doAction = async (actionRequest, options = {}) => {
      const preModel = extractModelFromActionRequest(actionRequest);

      const result = await _superDoAction(actionRequest, options);

      // esperar a que el controller exista de verdad
      setTimeout(() => {
        const postModel = extractModelFromController(res.currentController);
        send(postModel || preModel, { reason: "doAction" });
      }, 0);

      return result;
    };

    return res;
  },
});
