/* eslint-disable */
/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { actionService } from "@web/webclient/actions/action_service";
import { detectActiveViewType } from "./normalize_event";
import { buildRecordOpenedTransition } from "./state_transition";

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

function safeId(value) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value);
}

function extractStateFromLocation() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const pathname = String(window.location.pathname || "");
  const pathParts = pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  return {
    model: params.get("model") || params.get("res_model") || params.get("active_model") || null,
    view_type: params.get("view_type") || null,
    res_id: safeId(params.get("id") || params.get("res_id") || (/^\d+$/.test(lastPart) ? lastPart : null)),
  };
}

function extractResIdFromDom() {
  try {
    const el = document.querySelector(
      ".o_form_view [data-res-id], .o_form_view [data-id], .o_form_view"
    );
    return safeId(
      el?.getAttribute?.("data-res-id") ||
        el?.getAttribute?.("data-id") ||
        el?.dataset?.resId ||
        el?.dataset?.id
    );
  } catch {
    return null;
  }
}

function extractRecordNameFromDom() {
  try {
    const selectors = [
      ".o_control_panel_breadcrumbs .o_last_breadcrumb_item",
      ".o_navbar_breadcrumbs .o_last_breadcrumb_item",
      ".o_form_view .o_field_widget[name='display_name']",
      ".o_form_view .o_field_char[name='name']",
      ".o_form_view [name='name']",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = cleanText(el?.innerText || el?.textContent || el?.value || "");
      if (text) return text;
    }
  } catch {}
  return null;
}

function extractStateFromController(ctrl) {
  const loc = extractStateFromLocation();
  if (!ctrl) {
    return {
      ...loc,
      view_type: loc.view_type || detectActiveViewType(),
      res_id: loc.res_id ?? extractResIdFromDom(),
      record_name: extractRecordNameFromDom(),
    };
  }
  const props = ctrl.props || {};
  const root = ctrl.model?.root || {};
  return {
    model: props.resModel || ctrl.action?.res_model || root.resModel || loc.model || null,
    view_type:
      props.viewType ||
      props.type ||
      ctrl.view?.type ||
      ctrl.action?.view_mode?.split?.(",")?.[0] ||
      loc.view_type ||
      detectActiveViewType(),
    res_id: props.resId ?? root.resId ?? loc.res_id ?? extractResIdFromDom() ?? null,
    record_name: extractRecordNameFromDom(),
  };
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
      const fromState = (() => {
        try {
          return (
            env.services.context_service?.getContext?.() ||
            extractStateFromController(res.currentController)
          );
        } catch {
          return extractStateFromController(res.currentController);
        }
      })();

      const result = await _superDoAction(actionRequest, options);

      // esperar a que el controller exista de verdad
      setTimeout(() => {
        const controllerState = extractStateFromController(res.currentController);
        const postModel = controllerState.model || extractModelFromController(res.currentController);
        send(postModel || preModel, { reason: "doAction" });

        const transition = buildRecordOpenedTransition({
          from: fromState,
          to: {
            ...controllerState,
            model: controllerState.model || postModel || preModel,
          },
        });
        if (transition) {
          aiWs?.sendEvent?.({
            type: "state_transition_event",
            event_name: transition.name,
            event_data: transition,
          });
        }
      }, 150);

      return result;
    };

    return res;
  },
});
