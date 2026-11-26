import { z } from "zod";

/** Lifecycle of a document version. Persisted in Postgres; Redis never holds it. */
export const VERSION_STATUSES = ["queued", "extracting", "extracted", "failed", "superseded"] as const;
export const VersionStatusSchema = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;

/** Review state of a value. Derived from the reviews table, never stored. */
export const REVIEW_STATES = ["pending", "approved", "corrected", "carried_over"] as const;
export const ReviewStateSchema = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * Why a field has no value. A gap is never a guess:
 * - not_found: the model says the document does not contain it (its reason is kept)
 * - not_returned: the model's response omitted the field
 * - invalid_value: the model's value could not be normalized for the field type
 * - evidence_not_found: the quoted evidence is not verbatim in this version's text
 * - value_not_in_evidence: the quote is real but does not contain the claimed value
 */
export const GAP_REASONS = [
  "not_found",
  "not_returned",
  "invalid_value",
  "evidence_not_found",
  "value_not_in_evidence",
] as const;
export const GapReasonSchema = z.enum(GAP_REASONS);
export type GapReason = z.infer<typeof GapReasonSchema>;

export const REVIEW_ACTIONS = ["approve", "correct"] as const;
export const ReviewActionSchema = z.enum(REVIEW_ACTIONS);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
