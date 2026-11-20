/* eslint-disable */
/** @odoo-module **/

import { buildTargetHintCaption, resolveTargetElement } from "./target_hint_resolver";

const DEFAULT_AUTO_DISMISS_MS = 10000;

let activeState = null;

// Dismiss any active target spotlight overlay and detach its listeners.
export function hideTargetHintOverlay() {
  if (!activeState) return;
  const state = activeState;
  activeState = null;

  if (state.timer) clearTimeout(state.timer);
  if (state.rafId) cancelAnimationFrame(state.rafId);
  window.removeEventListener("scroll", state.onReposition, true);
  window.removeEventListener("resize", state.onReposition);
  document.removeEventListener("pointerdown", state.onInteract, true);
  document.removeEventListener("focusin", state.onInteract, true);
  document.removeEventListener("change", state.onInteract, true);
  document.removeEventListener("keydown", state.onKeyDown, true);

  try {
    state.layer.remove();
  } catch {}
}

// Show a non-blocking pulsing spotlight ring and pointer bubble on a target element.
export function showTargetHintOverlay(target, options = {}) {
  const el = target instanceof Element ? target : resolveTargetElement(target, document);
  if (!el) return false;

  hideTargetHintOverlay();

  try {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  } catch {}

  const caption = options.caption || buildTargetHintCaption(target instanceof Element ? null : target);
  const durationMs = Number(options.durationMs) > 0 ? Number(options.durationMs) : DEFAULT_AUTO_DISMISS_MS;

  const layer = document.createElement("div");
  layer.className = "ai-target-spotlight-layer";
  layer.setAttribute("data-ai-tutor-ignore-event", "true");

  const ring = document.createElement("div");
  ring.className = "ai-target-spotlight-ring";

  const pulse = document.createElement("span");
  pulse.className = "ai-target-spotlight-pulse";
  ring.appendChild(pulse);

  const bubble = document.createElement("div");
  bubble.className = "ai-target-spotlight-bubble";
  const dot = document.createElement("span");
  dot.className = "ai-target-spotlight-dot";
  const label = document.createElement("span");
  label.className = "ai-target-spotlight-label";
  label.textContent = caption;
  bubble.appendChild(dot);
  bubble.appendChild(label);

  layer.appendChild(ring);
  layer.appendChild(bubble);
  document.body.appendChild(layer);

  const positionOverlay = () => {
    if (!document.body.contains(el)) {
      hideTargetHintOverlay();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideTargetHintOverlay();
      return;
    }

    const pad = 6;
    ring.style.left = `${Math.max(2, rect.left - pad)}px`;
    ring.style.top = `${Math.max(2, rect.top - pad)}px`;
    ring.style.width = `${rect.width + pad * 2}px`;
    ring.style.height = `${rect.height + pad * 2}px`;

    const bubbleRect = bubble.getBoundingClientRect();
    const bubbleW = bubbleRect.width || 160;
    const bubbleH = bubbleRect.height || 34;
    const spaceAbove = rect.top - pad - 10;
    const placeBelow = spaceAbove < bubbleH + 8;

    const top = placeBelow
      ? Math.min(window.innerHeight - bubbleH - 8, rect.bottom + pad + 10)
      : Math.max(8, rect.top - pad - bubbleH - 10);
    const idealLeft = rect.left + rect.width / 2 - bubbleW / 2;
    const left = Math.max(8, Math.min(window.innerWidth - bubbleW - 8, idealLeft));

    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.classList.toggle("is-below", placeBelow);
  };

  const state = {
    layer,
    timer: null,
    rafId: null,
    onReposition: () => {
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = requestAnimationFrame(positionOverlay);
    },
    onInteract: (ev) => {
      if (ev.target && (el === ev.target || el.contains(ev.target))) {
        hideTargetHintOverlay();
      }
    },
    onKeyDown: (ev) => {
      if (ev.key === "Escape") {
        hideTargetHintOverlay();
      }
    },
  };

  activeState = state;
  positionOverlay();
  // Reposition once more after smooth scroll settles.
  setTimeout(() => {
    if (activeState === state) positionOverlay();
  }, 260);

  window.addEventListener("scroll", state.onReposition, true);
  window.addEventListener("resize", state.onReposition);
  document.addEventListener("pointerdown", state.onInteract, true);
  document.addEventListener("focusin", state.onInteract, true);
  document.addEventListener("change", state.onInteract, true);
  document.addEventListener("keydown", state.onKeyDown, true);

  state.timer = setTimeout(() => {
    if (activeState === state) hideTargetHintOverlay();
  }, durationMs);

  return true;
}
