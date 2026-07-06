/* eslint-disable */
/** @odoo-module **/

/**
 * Splits `text` into segments, marking the parts that match a copy target's
 * `text` as copyable. Targets come from the backend's validation contract
 * (see ai/copy_targets.py), so a match here is guaranteed to be the exact
 * string the deterministic validator expects for this step.
 *
 * Longest targets are matched first so a shorter target's text never steals
 * a match that belongs to a longer one that contains it.
 *
 * @param {string} text
 * @param {Array<{text: string, field?: string|null, field_label?: string|null}>} targets
 * @returns {Array<{text: string, isCopy: boolean, target?: object, copyLabel?: string}>}
 */
export function buildCopySegments(text, targets) {
  const raw = String(text ?? "");

  const sorted = (Array.isArray(targets) ? targets : [])
    .filter((t) => t && t.text != null && String(t.text).trim() !== "")
    .sort((a, b) => String(b.text).length - String(a.text).length);

  if (!raw || !sorted.length) {
    return [{ text: raw, isCopy: false }];
  }

  let segments = [{ text: raw, isCopy: false }];

  for (const target of sorted) {
    const needle = String(target.text);
    const needleLower = needle.toLowerCase();
    const nextSegments = [];

    for (const seg of segments) {
      if (seg.isCopy) {
        nextSegments.push(seg);
        continue;
      }

      const lower = seg.text.toLowerCase();
      const idx = lower.indexOf(needleLower);
      if (idx === -1) {
        nextSegments.push(seg);
        continue;
      }

      const before = seg.text.slice(0, idx);
      const matched = seg.text.slice(idx, idx + needle.length);
      const after = seg.text.slice(idx + needle.length);

      if (before) nextSegments.push({ text: before, isCopy: false });
      nextSegments.push({
        text: matched,
        isCopy: true,
        target,
        copyLabel: target.field_label
          ? `Click to copy · paste into ${target.field_label}`
          : "Click to copy",
      });
      if (after) nextSegments.push({ text: after, isCopy: false });
    }

    segments = nextSegments;
  }

  const filtered = segments.filter((seg) => seg.text !== "");
  return filtered.length ? filtered : [{ text: raw, isCopy: false }];
}

/**
 * LLM-generated instructions occasionally put a copy-target value on its
 * own line (e.g. "Set the Quantity of Premium Desk to\n4\n."). The bubble
 * preview renders plain text, where stray newlines just collapse into
 * whitespace, so it looks fine there — but the full chat view renders
 * through nlux's markdown parser, which turns those newlines into real
 * line/paragraph breaks, stranding the value chip (and any trailing
 * punctuation) on their own line.
 *
 * This glues a copy target's value back into its sentence by collapsing
 * newlines that sit directly against a known target's exact text into a
 * single space, without touching newlines anywhere else in the message
 * (e.g. intentional bullet lists, which never have copy targets).
 *
 * @param {string} text
 * @param {Array<{text: string}>} targets
 * @returns {string}
 */
export function stripNewlinesAroundCopyTargets(text, targets) {
  let result = String(text ?? "");

  const sorted = (Array.isArray(targets) ? targets : [])
    .filter((t) => t && t.text != null && String(t.text).trim() !== "")
    .sort((a, b) => String(b.text).length - String(a.text).length);

  for (const target of sorted) {
    const needle = String(target.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`[ \\t]*\\n+[ \\t]*(${needle})[ \\t]*\\n+[ \\t]*`, "gi");
    result = result.replace(re, " $1 ");
  }

  return result.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Normalizes assistant text the same way ai_sidebar.js does before using it
 * as a lookup key, so copy targets registered against a raw tutor_push
 * payload can be matched against the (possibly reformatted) rendered DOM
 * text later.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForCopyTargetLookup(text) {
  return String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
