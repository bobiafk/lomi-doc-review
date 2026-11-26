import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DocumentTypeSchema, FIELD_DEFINITIONS, FieldDefinitionSchema } from "./fields.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), "utf8"));

describe("field definitions", () => {
  it("match fixtures/expected-fields.json exactly", () => {
    const parsed = z.record(z.string(), z.array(FieldDefinitionSchema)).parse(fixture("expected-fields.json"));
    expect(FIELD_DEFINITIONS).toEqual(parsed);
  });

  it("cover every document type in the manifest", () => {
    const manifest = z.array(z.object({ type: z.string() })).parse(fixture("documents.json"));
    for (const doc of manifest) {
      expect(DocumentTypeSchema.safeParse(doc.type).success, doc.type).toBe(true);
    }
  });
});
