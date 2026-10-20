/* eslint-disable */
/** @odoo-module **/

/** Split assistant text into copyable segments based on the supplied targets. */
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

/** Collapse newlines next to copy targets so Markdown keeps each value with its sentence. */
export function stripNewlinesAroundCopyTargets(text, targets) {
  let result = String(text ?? "");

  const sorted = (Array.isArray(targets) ? targets : [])
    .filter((t) => t && t.text != null && String(t.text).trim() !== "")
    .sort((a, b) => String(b.text).length - String(a.text).length);

  // Allow Markdown emphasis and backticks around target values.
  const MD_WRAP = "(?:\\*{1,2}|_{1,2}|`)?";

  for (const target of sorted) {
    const needle = String(target.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = `${MD_WRAP}${needle}${MD_WRAP}`;

    // Collapse newlines immediately before a target value.
    result = result.replace(
      new RegExp(`[ \\t]*\\n+[ \\t]*(${wrapped})`, "gi"),
      " $1"
    );
    // Collapse newlines before trailing punctuation.
    result = result.replace(
      new RegExp(`(${wrapped})[ \\t]*\\n+[ \\t]*([.,;:!?])`, "gi"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(${wrapped})[ \\t]*\\n+[ \\t]*`, "gi"),
      "$1 "
    );
  }

  return result.replace(/[ \t]{2,}/g, " ").trim();
}

/** Normalize assistant text for matching copy targets against rendered messages. */
export function normalizeForCopyTargetLookup(text) {
  return String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
