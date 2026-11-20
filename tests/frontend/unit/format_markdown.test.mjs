import { describe, expect, it } from "vitest";
import { buildCopySegments } from "../../../odoo_mentor/static/src/core/copy_targets.js";
import {
  formatPreviewSegments,
  renderInlineMarkdownHtml,
} from "../../../odoo_mentor/static/src/core/format_markdown.js";

describe("format_markdown", () => {
  it("renders **bold** spans cleanly as <strong> without leaving literal asterisks", () => {
    const input =
      "The **Max Quantity** is the target stock level for this replenishment rule. When stock falls below the minimum, Odoo suggests replenishing up to **50 units**—subject to the order multiple, if one is set.";
    const html = renderInlineMarkdownHtml(input);

    expect(html).toContain("<strong>Max Quantity</strong>");
    expect(html).toContain("<strong>50 units</strong>—subject");
    expect(html).not.toContain("**");
  });

  it("escapes raw HTML before applying inline Markdown (XSS-safe)", () => {
    const html = renderInlineMarkdownHtml(
      "Click **<script>alert(1)</script>** and use `sale_order`.\nNext line",
    );

    expect(html).toBe(
      "<p>Click <strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong> and use <code>sale_order</code>.<br/>Next line</p>",
    );
  });

  it("preserves asterisks inside inline code and multiplication", () => {
    const html = renderInlineMarkdownHtml("Use `**raw**` or compute 2 * 3 = 6.");
    expect(html).toBe("<p>Use <code>**raw**</code> or compute 2 * 3 = 6.</p>");
  });

  it("builds preview segments with bold spans and copy targets without leaking **", () => {
    const segments = formatPreviewSegments(
      buildCopySegments("Set **Max Quantity** to **50**.", [
        { text: "50", field: "product_max_qty", field_label: "Max Quantity" },
      ]),
    );

    expect(segments.map((s) => ({ text: s.text, isCopy: s.isCopy, isBold: !!s.isBold }))).toEqual([
      { text: "Set ", isCopy: false, isBold: false },
      { text: "Max Quantity", isCopy: false, isBold: true },
      { text: " to ", isCopy: false, isBold: false },
      { text: "50", isCopy: true, isBold: false },
      { text: ".", isCopy: false, isBold: false },
    ]);
  });
});
