import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, EXTRACTION_TOOL_NAME } from "../src/prompt.js";

describe("buildExtractionPrompt", () => {
  const prompt = buildExtractionPrompt("lease", "LEASE TEXT\nmonthly rent of $2,350.00");

  it("asks for every field of the type through a forced tool", () => {
    expect(prompt.tool.name).toBe(EXTRACTION_TOOL_NAME);
    const fieldsSchema = prompt.tool.input_schema.properties.fields;
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
    const props = prompt.tool.input_schema.properties.fields.properties;
    expect(props["monthly_rent"]?.required).toContain("currency");
    expect(props["term_months"]?.required).not.toContain("currency");
  });

  it("embeds the document text verbatim and demands verbatim quotes", () => {
    expect(prompt.user).toContain("LEASE TEXT\nmonthly rent of $2,350.00");
    expect(prompt.system).toMatch(/verbatim/i);
  });

  it("is deterministic, so the stored prompt reproduces the call", () => {
    expect(buildExtractionPrompt("lease", "LEASE TEXT\nmonthly rent of $2,350.00")).toEqual(prompt);
  });
});
