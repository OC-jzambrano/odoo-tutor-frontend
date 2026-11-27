import { describe, expect, it } from "vitest";
import {
  extractQuickReplies,
  getQuickReplyVariantClass,
  normalizeQuickReplyItem,
  normalizeQuickReplyVariant,
} from "../../../odoo_mentor/static/src/core/quick_replies.js";

describe("quick_replies extraction and normalization", () => {
  it("extracts and sanitizes quick_replies from chat_response payloads", () => {
    const replies = extractQuickReplies({
      type: "chat_response",
      mode: "awaiting_exercise_switch",
      quick_replies: [
        { id: "switch", label: "Switch", message: "switch", variant: "primary" },
        { id: "continue", label: "Continue", message: "continue", variant: "secondary" },
        { id: "cancel", label: "Cancel", message: "cancel", variant: "danger" },
      ],
    });

    expect(replies).toEqual([
      { id: "switch", label: "Switch", message: "switch", variant: "primary" },
      { id: "continue", label: "Continue", message: "continue", variant: "secondary" },
      { id: "cancel", label: "Cancel", message: "cancel", variant: "danger" },
    ]);
  });

  it("extracts Spanish quick_replies and falls back when only mode is awaiting_exercise_switch", () => {
    const esReplies = extractQuickReplies({
      mode: "awaiting_exercise_switch",
      lang: "es",
      response: "¿Quieres cambiar de ejercicio?",
    });
    expect(esReplies.map((r) => [r.label, r.message, r.variant])).toEqual([
      ["Cambiar", "switch", "primary"],
      ["Continuar", "continue", "secondary"],
      ["Cancelar", "cancel", "danger"],
    ]);

    const enReplies = extractQuickReplies({
      mode: "awaiting_exercise_switch",
      response: "You already have an active exercise. What would you like to do?",
    });
    expect(enReplies.map((r) => [r.label, r.message, r.variant])).toEqual([
      ["Switch", "switch", "primary"],
      ["Continue", "continue", "secondary"],
      ["Cancel", "cancel", "danger"],
    ]);
  });

  it("normalizes unknown variants to secondary and maps CSS classes", () => {
    expect(normalizeQuickReplyVariant("primary")).toBe("primary");
    expect(normalizeQuickReplyVariant("DANGER")).toBe("danger");
    expect(normalizeQuickReplyVariant("unknown")).toBe("secondary");
    expect(getQuickReplyVariantClass("primary")).toBe("ai-quick-reply-btn--primary");
    expect(getQuickReplyVariantClass("secondary")).toBe("ai-quick-reply-btn--secondary");
    expect(getQuickReplyVariantClass("danger")).toBe("ai-quick-reply-btn--danger");
  });

  it("ignores invalid items and returns empty array for normal chat responses", () => {
    expect(normalizeQuickReplyItem({})).toBeNull();
    expect(extractQuickReplies({ mode: "idle", response: "Hello!" })).toEqual([]);
  });
});
