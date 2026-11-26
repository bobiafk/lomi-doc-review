import type { Prisma } from "@lomi/db";
import {
  fieldsFor,
  FieldValueSchema,
  GapReasonSchema,
  type DocumentType,
  type FieldType,
  type FieldValue,
  type Progress,
  type ReviewDto,
  type ReviewState,
  type ValueDto,
  type VersionSummary,
} from "@lomi/shared";

/**
 * Turning rows into the API contract. The review state of a value is derived
 * here, never stored: no review -> pending; latest review carried over ->
 * carried_over; otherwise the latest review's action.
 */

/** Latest review first; ties broken by id (uuid v7 is time-ordered). */
export const latestReviewFirst = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.ReviewOrderByWithRelationInput[];

export const reviewInclude = {
  carriedFrom: { select: { id: true, value: { select: { version: { select: { versionNo: true } } } } } },
} satisfies Prisma.ReviewInclude;

export const valueInclude = {
  reviews: { orderBy: latestReviewFirst, take: 1, include: reviewInclude },
  previousValue: {
    include: {
      version: { select: { versionNo: true } },
      reviews: { orderBy: latestReviewFirst, take: 1, include: reviewInclude },
    },
  },
} satisfies Prisma.ExtractedValueInclude;

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;
type ValueRow = Prisma.ExtractedValueGetPayload<{ include: typeof valueInclude }>;
type BareValueRow = Prisma.ExtractedValueGetPayload<object>;

export function reviewState(latest: { action: string; carriedFromReviewId: string | null } | undefined): ReviewState {
  if (!latest) return "pending";
  if (latest.carriedFromReviewId) return "carried_over";
  return latest.action === "correct" ? "corrected" : "approved";
}

function fieldValue(json: Prisma.JsonValue | null): FieldValue | null {
  return json === null ? null : FieldValueSchema.parse(json);
}

export function toReviewDto(review: ReviewRow | undefined): ReviewDto | null {
  if (!review) return null;
  return {
    id: review.id,
    action: review.action,
    correctedValue: fieldValue(review.correctedValue),
    note: review.note,
    createdAt: review.createdAt.toISOString(),
    carriedFrom: review.carriedFrom
      ? { reviewId: review.carriedFrom.id, versionNo: review.carriedFrom.value.version.versionNo }
      : null,
  };
}

function gapOf(row: BareValueRow): ValueDto["gap"] {
  if (row.gapReason === null) return null;
  return {
    reason: GapReasonSchema.parse(row.gapReason),
    detail: row.gapDetail,
    unverifiedQuote: row.evidenceText,
  };
}

export function fieldTypeOf(type: DocumentType, field: string): FieldType {
  return fieldsFor(type).find((f) => f.field === field)?.type ?? "string";
}

export function toValueDto(type: DocumentType, row: ValueRow): ValueDto {
  const latest = row.reviews[0];
  const extractedValue = fieldValue(row.value);
  const review = toReviewDto(latest);
  const previous = row.previousValue;
  return {
    id: row.id,
    field: row.field,
    fieldType: fieldTypeOf(type, row.field),
    extractedValue,
    effectiveValue: review?.action === "correct" ? review.correctedValue : extractedValue,
    evidence:
      row.gapReason === null && row.evidenceText !== null && row.evidenceStart !== null && row.evidenceEnd !== null
        ? { text: row.evidenceText, start: row.evidenceStart, end: row.evidenceEnd }
        : null,
    gap: gapOf(row),
    reviewState: reviewState(latest),
    review,
    previous: previous
      ? {
          valueId: previous.id,
          versionNo: previous.version.versionNo,
          value: fieldValue(previous.value),
          gap: gapOf(previous),
          review: toReviewDto(previous.reviews[0]),
        }
      : null,
  };
}

/** Values in the document type's field order. */
export function sortByFieldOrder<T extends { field: string }>(type: DocumentType, values: T[]): T[] {
  const order = new Map(fieldsFor(type).map((f, i) => [f.field, i]));
  return [...values].sort((a, b) => (order.get(a.field) ?? 99) - (order.get(b.field) ?? 99));
}

export function progressOf(values: { gapReason: string | null; reviews: { action: string; carriedFromReviewId: string | null }[] }[]): Progress {
  const progress: Progress = { total: values.length, pending: 0, gaps: 0, approved: 0, corrected: 0, carriedOver: 0 };
  for (const value of values) {
    const state = reviewState(value.reviews[0]);
    if (state === "pending") {
      if (value.gapReason !== null) progress.gaps++;
      else progress.pending++;
    } else if (state === "carried_over") progress.carriedOver++;
    else progress[state]++;
  }
  return progress;
}

export function toVersionSummary(v: {
  id: string;
  versionNo: number;
  status: VersionSummary["status"];
  fileName: string;
  createdAt: Date;
}): VersionSummary {
  return { id: v.id, versionNo: v.versionNo, status: v.status, fileName: v.fileName, createdAt: v.createdAt.toISOString() };
}
