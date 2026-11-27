/** @odoo-module **/

// Queue tutor messages whenever the chat is unmounted or closed to preserve order.
export function shouldQueueTutorMessage({ aiChat, isSidebarOpen }) {
  return !aiChat || !isSidebarOpen;
}

export function buildTutorStepKey(payload, fallbackExerciseId = null) {
  if (!payload || typeof payload !== "object") return null;
  const rawStep = payload.current_step ?? payload.step_index ?? payload.step;
  if (rawStep === undefined || rawStep === null || rawStep === "") return null;
  const exerciseId = String(payload.exercise_id || fallbackExerciseId || "").trim();
  return `${exerciseId}:${String(rawStep).trim()}`;
}

export function isDuplicateTutorAssistantMessage({
  normalizedText,
  stepKey = null,
  lastInjectedText = "",
  lastInjectedAt = 0,
  lastInjectedStepKey = null,
  lastDomText = "",
  now = Date.now(),
  recentWindowMs = 6000,
}) {
  if (!normalizedText) return true;

  if (stepKey && lastInjectedStepKey) {
    if (stepKey !== lastInjectedStepKey) {
      return false;
    }
    if (lastInjectedText === normalizedText) {
      return true;
    }
  }

  if (lastInjectedText === normalizedText && now - lastInjectedAt < recentWindowMs) {
    return true;
  }

  if (!stepKey && lastDomText && lastDomText === normalizedText) {
    return true;
  }

  return false;
}
