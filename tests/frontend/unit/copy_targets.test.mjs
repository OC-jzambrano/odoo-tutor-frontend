import { describe, expect, it } from "vitest";
import {
  buildCopySegments,
  normalizeForCopyTargetLookup,
  stripNewlinesAroundCopyTargets,
} from "../../../odoo_tutor/static/src/core/copy_targets.js";

describe("buildCopySegments", () => {
  it("returns the whole text as non-copy when there are no targets", () => {
    expect(buildCopySegments("Click Save.", [])).toEqual([
      { text: "Click Save.", isCopy: false },
    ]);
    expect(buildCopySegments("Click Save.", null)).toEqual([
      { text: "Click Save.", isCopy: false },
    ]);
  });

  it("returns the whole text as non-copy for empty text", () => {
    expect(buildCopySegments("", [{ text: "Azure Interior" }])).toEqual([
      { text: "", isCopy: false },
    ]);
  });

  it("marks a single matching value as copyable and keeps surrounding text intact", () => {
    const segments = buildCopySegments(
      "Select Azure Interior in the Customer field.",
      [{ text: "Azure Interior", field: "partner_id", field_label: "Customer" }]
    );

    expect(segments).toEqual([
      { text: "Select ", isCopy: false },
      {
        text: "Azure Interior",
        isCopy: true,
        target: { text: "Azure Interior", field: "partner_id", field_label: "Customer" },
        copyLabel: "Click to copy · paste into Customer",
      },
      { text: " in the Customer field.", isCopy: false },
    ]);
  });

  it("matches case-insensitively but preserves the original casing from the source text", () => {
    const segments = buildCopySegments("select AZURE INTERIOR now", [
      { text: "Azure Interior" },
    ]);

    expect(segments.find((s) => s.isCopy).text).toBe("AZURE INTERIOR");
  });

  it("handles multiple distinct targets in the same message", () => {
    const segments = buildCopySegments(
      "Enter 25000 in Expected Revenue and select Mitchell Admin as Salesperson.",
      [
        { text: "25000", field: "expected_revenue", field_label: "Expected Revenue" },
        { text: "Mitchell Admin", field: "user_id", field_label: null },
      ]
    );

    const copySegments = segments.filter((s) => s.isCopy);
    expect(copySegments.map((s) => s.text)).toEqual(["25000", "Mitchell Admin"]);
  });

  it("prefers the longest target when one target's text is a substring of another", () => {
    const segments = buildCopySegments("Type Azure Interior Corp here.", [
      { text: "Azure Interior" },
      { text: "Azure Interior Corp" },
    ]);

    const copySegments = segments.filter((s) => s.isCopy);
    expect(copySegments).toHaveLength(1);
    expect(copySegments[0].text).toBe("Azure Interior Corp");
  });

  it("omits field_label from copyLabel when absent", () => {
    const segments = buildCopySegments("Select Mitchell Admin.", [
      { text: "Mitchell Admin", field: "user_id" },
    ]);

    expect(segments.find((s) => s.isCopy).copyLabel).toBe("Click to copy");
  });

  it("returns the whole text unmodified when no target text appears in it", () => {
    const segments = buildCopySegments("Click the Save button.", [
      { text: "Azure Interior" },
    ]);

    expect(segments).toEqual([{ text: "Click the Save button.", isCopy: false }]);
  });

  it("ignores targets with blank or missing text", () => {
    const segments = buildCopySegments("Select Azure Interior now.", [
      { text: "" },
      { text: "   " },
      { text: null },
      { text: "Azure Interior" },
    ]);

    expect(segments.filter((s) => s.isCopy)).toHaveLength(1);
  });
});

describe("stripNewlinesAroundCopyTargets", () => {
  it("glues a value stranded on its own line back into the sentence", () => {
    expect(
      stripNewlinesAroundCopyTargets(
        "Set the Quantity of Premium Desk to\n4\n.",
        [{ text: "4" }]
      )
    ).toBe("Set the Quantity of Premium Desk to 4.");
  });

  it("handles multiple newlines and surrounding spaces around the target", () => {
    expect(
      stripNewlinesAroundCopyTargets(
        "Select\n\n  Azure Interior  \n\nin the Customer field.",
        [{ text: "Azure Interior" }]
      )
    ).toBe("Select Azure Interior in the Customer field.");
  });

  it("leaves text unchanged when there are no targets", () => {
    const text = "Line one\nLine two";
    expect(stripNewlinesAroundCopyTargets(text, [])).toBe(text);
    expect(stripNewlinesAroundCopyTargets(text, null)).toBe(text);
  });

  it("does not touch newlines unrelated to a copy target, e.g. bullet lists", () => {
    const text = "Hi, I'm Odoo Tutor.\n• Practice exercises\n• Answer questions";
    expect(stripNewlinesAroundCopyTargets(text, [{ text: "Odoo Tutor" }])).toBe(
      text
    );
  });

  it("glues a markdown-bold value stranded on its own line back into the sentence", () => {
    expect(
      stripNewlinesAroundCopyTargets(
        "Good job. In the Product field, create a new storable product named\n**Product Z**\n.",
        [{ text: "Product Z" }]
      )
    ).toBe(
      "Good job. In the Product field, create a new storable product named **Product Z**."
    );
  });

  it("glues punctuation that immediately follows a stranded copy target", () => {
    expect(
      stripNewlinesAroundCopyTargets("Create\nProduct Z\n, then save.", [
        { text: "Product Z" },
      ])
    ).toBe("Create Product Z, then save.");
    expect(
      stripNewlinesAroundCopyTargets("Create\nProduct Z\n. Then save.", [
        { text: "Product Z" },
      ])
    ).toBe("Create Product Z. Then save.");
  });

  it("normalizes the screenshot Product Z message end-to-end", () => {
    expect(
      stripNewlinesAroundCopyTargets(
        "Good job. In the Product field, create a new storable product named\n**Product Z**\n.",
        [{ text: "Product Z", field: "name", field_label: "Product" }]
      )
    ).toBe(
      "Good job. In the Product field, create a new storable product named **Product Z**."
    );
  });

  it("handles backtick-wrapped values around newlines", () => {
    expect(
      stripNewlinesAroundCopyTargets("Type\n`SO001`\nin the field.", [
        { text: "SO001" },
      ])
    ).toBe("Type `SO001` in the field.");
  });

  it("glues a value with a newline on only one side", () => {
    expect(
      stripNewlinesAroundCopyTargets("Create a product named\n**Product Z**.", [
        { text: "Product Z" },
      ])
    ).toBe("Create a product named **Product Z**.");
    expect(
      stripNewlinesAroundCopyTargets("Enter 4\nin the Quantity field.", [
        { text: "4" },
      ])
    ).toBe("Enter 4 in the Quantity field.");
  });

  it("handles several distinct targets in the same message", () => {
    expect(
      stripNewlinesAroundCopyTargets(
        "Enter\n25000\nin Expected Revenue and select\nMitchell Admin\nas Salesperson.",
        [{ text: "25000" }, { text: "Mitchell Admin" }]
      )
    ).toBe(
      "Enter 25000 in Expected Revenue and select Mitchell Admin as Salesperson."
    );
  });
});

describe("normalizeForCopyTargetLookup", () => {
  it("strips markdown emphasis, backticks, and collapses whitespace/case", () => {
    expect(
      normalizeForCopyTargetLookup("  **Select**  `Azure`\n\nInterior. ")
    ).toBe("select azure interior.");
  });

  it("returns an empty string for null/undefined input", () => {
    expect(normalizeForCopyTargetLookup(null)).toBe("");
    expect(normalizeForCopyTargetLookup(undefined)).toBe("");
  });
});
