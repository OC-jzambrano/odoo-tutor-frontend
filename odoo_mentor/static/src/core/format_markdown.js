/* eslint-disable */
/** @odoo-module **/

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Safely render inline Markdown (**bold**, `code`, *italic*, newlines) into HTML.
export function renderInlineMarkdownHtml(text) {
  let html = escapeHtml(text);

  // Protect inline code spans so asterisks inside code stay literal.
  const codeTokens = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE_${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  // Render bold spans.
  html = html.replace(/\*\*([^\n*]+(?:\*(?!\*)[^\n*]*)*)\*\*/g, "<strong>$1</strong>");

  // Render italic spans without affecting list bullets or multiplication.
  html = html.replace(/(^|[^*\w])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?!\*)/g, "$1<em>$2</em>");

  // Restore inline code spans.
  html = html.replace(/\u0000CODE_(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || "");

  // Wrap paragraphs in <p> so inline elements flow normally inside flex containers.
  const paragraphs = html.split(/\r?\n\s*\r?\n/);
  return paragraphs
    .map((para) => `<p>${para.replace(/\r?\n/g, "<br/>")}</p>`)
    .join("");
}

// Convert **bold** spans in copy-target preview segments without leaking asterisks.
export function formatPreviewSegments(copySegments) {
  const segments = Array.isArray(copySegments) ? copySegments : [];
  const result = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.isCopy) {
      result.push({ ...seg, isBold: false });
      continue;
    }

    let chunk = String(seg.text ?? "");
    // Strip orphaned bold markers adjacent to a copy target.
    const prevIsCopy = i > 0 && segments[i - 1].isCopy;
    const nextIsCopy = i + 1 < segments.length && segments[i + 1].isCopy;
    if (nextIsCopy && chunk.endsWith("**")) {
      chunk = chunk.slice(0, -2);
    }
    if (prevIsCopy && chunk.startsWith("**")) {
      chunk = chunk.slice(2);
    }

    const boldRe = /\*\*([^\n*]+(?:\*(?!\*)[^\n*]*)*)\*\*/g;
    let lastIdx = 0;
    let match;
    while ((match = boldRe.exec(chunk)) !== null) {
      if (match.index > lastIdx) {
        result.push({ text: chunk.slice(lastIdx, match.index), isCopy: false, isBold: false });
      }
      result.push({ text: match[1], isCopy: false, isBold: true });
      lastIdx = boldRe.lastIndex;
    }
    if (lastIdx < chunk.length) {
      result.push({ text: chunk.slice(lastIdx), isCopy: false, isBold: false });
    }
  }

  return result.filter((seg) => seg.text !== "");
}
