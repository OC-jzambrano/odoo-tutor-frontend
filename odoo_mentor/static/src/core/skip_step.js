/** @odoo-module **/

export function buildSkipStepRequest({ exerciseId, context = {} }) {
  return {
    message: "next",
    context: {
      ...context,
      exercise_id: exerciseId,
      exercise_action: "next",
    },
    payloadExtra: {
      exercise_id: exerciseId,
      exercise_action: "next",
    },
  };
}

export function getVisibleSkipResponse(response, extractText, isDuplicate) {
  const text = extractText(response);
  return text && !isDuplicate(text) ? text : "";
}
