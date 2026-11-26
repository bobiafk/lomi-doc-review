import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "../src/prompt.js";

describe("buildExtractionPrompt", () => {
  const prompt = buildExtractionPrompt("lease", "LEASE TEXT\nmonthly rent of $2,350.00");

  it("asks for every field of the type, and nothing else", () => {
    const fieldsSchema = prompt.schema.properties.fields;
    expect(fieldsSchema.required).toEqual([
      "tenant_name",
      "monthly_rent",
      "security_deposit",
      "lease_start",
      "term_months",
    ]);
    expect(fieldsSchema.additionalProperties).toBe(false);
  });

  it("asks for currency only on money fields", () => {
    const props = prompt.schema.properties.fields.properties;
    expect(props["monthly_rent"]?.required).toContain("currency");
    expect(props["term_months"]?.required).not.toContain("currency");
  });

  it("closes every object, as structured outputs require", () => {
    const objects: unknown[] = [];
    const walk = (node: unknown): void => {
      if (node && typeof node === "object") {
        if ((node as { type?: string }).type === "object") objects.push(node);
        Object.values(node).forEach(walk);
      }
    };
    walk(prompt.schema);
    expect(objects.length).toBeGreaterThan(1);
    for (const o of objects) expect(o).toMatchObject({ additionalProperties: false });
  });

  it("embeds the document text verbatim and demands verbatim quotes", () => {
    expect(prompt.user).toContain("LEASE TEXT\nmonthly rent of $2,350.00");
    expect(prompt.system).toMatch(/verbatim/i);
  });

  it("is deterministic, so the stored prompt reproduces the call", () => {
    expect(buildExtractionPrompt("lease", "LEASE TEXT\nmonthly rent of $2,350.00")).toEqual(prompt);
  });
});
