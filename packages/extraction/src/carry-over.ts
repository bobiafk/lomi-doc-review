import type { FieldValue, GapReason } from "@lomi/shared";
import { locateEvidence } from "./text.js";
import type { ExtractedField } from "./validate.js";
import { valuesEqual } from "./values.js";

/** A value from the latest previously *extracted* version of the document. */
export interface PreviousValue {
  id: string;
  field: string;
  value: FieldValue | null;
  evidenceText: string | null;
  gapReason: GapReason | null;
  /** Id of the value's current (latest) review, or null if never reviewed. */
  latestReviewId: string | null;
}

export type CarryOverReason =
  | "unchanged"
  | "value_changed"
  | "evidence_changed"
  | "not_reviewed"
  | "previous_was_gap"
  | "now_a_gap"
  | "no_previous_value";

export interface CarryOverDecision {
  field: string;
  /** Link to the previous version's value, so the UI can show old value + old review. */
  previousValueId: string | null;
  /** Review to copy forward (as a new row with carried_from_review_id); null = pending. */
  carryReviewId: string | null;
  reason: CarryOverReason;
}

/**
 * A review carries over only when BOTH hold:
 *  1. the normalized value is unchanged, and
 *  2. the old evidence quote still appears verbatim (after whitespace
 *     normalization) in the new version's text.
 * Positions are deliberately ignored, so text moving around the page does not
 * reset reviews. Gaps never carry: "confirmed absent" is re-confirmed per version.
 */
export function planCarryOver(input: {
  previous: PreviousValue[];
  current: ExtractedField[];
  currentParsedText: string;
}): CarryOverDecision[] {
  const previousByField = new Map(input.previous.map((p) => [p.field, p]));

  return input.current.map((cur) => {
    const prev = previousByField.get(cur.field);
    const decide = (reason: CarryOverReason, carryReviewId: string | null = null): CarryOverDecision => ({
      field: cur.field,
      previousValueId: prev?.id ?? null,
      carryReviewId,
      reason,
    });

    if (!prev) return decide("no_previous_value");
    if (prev.gapReason !== null || prev.evidenceText === null) return decide("previous_was_gap");
    if (cur.gapReason !== null) return decide("now_a_gap");
    if (!valuesEqual(prev.value, cur.value)) return decide("value_changed");
    if (!locateEvidence(input.currentParsedText, prev.evidenceText)) return decide("evidence_changed");
    if (prev.latestReviewId === null) return decide("not_reviewed");
    return decide("unchanged", prev.latestReviewId);
  });
}
