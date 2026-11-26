import { fieldsFor, type DocumentType, type FieldValue, type GapReason } from "@lomi/shared";
import { parseExtractionResponse } from "./response.js";
import { locateEvidence } from "./text.js";
import { normalizeValue, valueSupportedByEvidence } from "./values.js";

/**
 * One row of extracted_values, before it has ids. Either an evidenced value
 * (value + evidence offsets into THIS version's text) or a gap with a reason.
 * Never an unverified value.
 */
export interface ExtractedField {
  field: string;
  value: FieldValue | null;
  /** For a value: the exact passage from parsed_text. For a gap: the model's quote, if any (debugging only). */
  evidenceText: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: GapReason | null;
  gapDetail: string | null;
}

/**
 * Turns the model's tool input into rows for `parsedText`. Throws
 * ExtractionResponseError when the response is unusable as a whole.
 */
export function validateExtraction(type: DocumentType, parsedText: string, toolInput: unknown): ExtractedField[] {
  const definitions = fieldsFor(type);
  const entries = parseExtractionResponse(
    definitions.map((d) => d.field),
    toolInput,
  );

  return definitions.map(({ field, type: fieldType }) => {
    const gap = (gapReason: GapReason, gapDetail: string | null = null, evidenceText: string | null = null) => ({
      field,
      value: null,
      evidenceText,
      evidenceStart: null,
      evidenceEnd: null,
      gapReason,
      gapDetail,
    });

    const entry = entries.get(field);
    if (!entry) return gap("not_returned");
    if (!entry.found || entry.value === null) return gap("not_found", entry.reason);

    const normalized = normalizeValue(fieldType, entry.value, entry.currency);
    if (!normalized.ok) return gap("invalid_value", normalized.error, entry.evidence);

    if (!entry.evidence) return gap("evidence_not_found");
    const span = locateEvidence(parsedText, entry.evidence);
    if (!span) return gap("evidence_not_found", null, entry.evidence);

    const evidenceText = parsedText.slice(span.start, span.end);
    if (!valueSupportedByEvidence(fieldType, normalized.value, evidenceText)) {
      return gap("value_not_in_evidence", null, evidenceText);
    }

    return {
      field,
      value: normalized.value,
      evidenceText,
      evidenceStart: span.start,
      evidenceEnd: span.end,
      gapReason: null,
      gapDetail: null,
    };
  });
}
