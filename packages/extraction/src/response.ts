import { z } from "zod";

/**
 * Shape of the model's structured JSON output. Parsed
 * leniently per field (a missing field becomes a gap, an unknown one is
 * ignored) but strictly per entry: an entry with the wrong shape fails the
 * whole response, because the run can no longer be trusted.
 */
export const LlmFieldResultSchema = z.object({
  found: z.boolean(),
  value: z.union([z.string(), z.number()]).nullable(),
  currency: z.string().nullable().optional(),
  evidence: z.string().nullable(),
  reason: z.string().nullable(),
});
export type LlmFieldResult = z.infer<typeof LlmFieldResultSchema>;

const ResponseSchema = z.object({
  fields: z.record(z.string(), z.unknown()),
});

export class ExtractionResponseError extends Error {
  override readonly name = "ExtractionResponseError";
}

/** Returns the model's entry for each of `fieldNames` (undefined when omitted). */
export function parseExtractionResponse(
  fieldNames: readonly string[],
  input: unknown,
): Map<string, LlmFieldResult | undefined> {
  const envelope = ResponseSchema.safeParse(input);
  if (!envelope.success) {
    throw new ExtractionResponseError(`response is not {"fields": {...}}: ${z.prettifyError(envelope.error)}`);
  }
  const results = new Map<string, LlmFieldResult | undefined>();
  for (const name of fieldNames) {
    const entry = envelope.data.fields[name];
    if (entry === undefined) {
      results.set(name, undefined);
      continue;
    }
    const parsed = LlmFieldResultSchema.safeParse(entry);
    if (!parsed.success) {
      throw new ExtractionResponseError(`field "${name}" is malformed: ${z.prettifyError(parsed.error)}`);
    }
    results.set(name, parsed.data);
  }
  return results;
}
