import { z } from "zod";
import { DocumentTypeSchema, FieldTypeSchema, FieldValueSchema } from "./fields.js";
import { GapReasonSchema, ReviewActionSchema, ReviewStateSchema, VersionStatusSchema } from "./status.js";

/**
 * The HTTP contract between apps/api and apps/web. Requests are validated
 * with these schemas on the server; responses are typed by them on both sides.
 */

// ---------------------------------------------------------------- requests

export const UploadDocumentFieldsSchema = z.object({
  type: DocumentTypeSchema,
  title: z.string().trim().min(1).max(200).optional(),
});

export const DocumentParamsSchema = z.object({ id: z.string().min(1).max(200) });
export const VersionParamsSchema = DocumentParamsSchema.extend({
  versionNo: z.coerce.number().int().positive(),
});
export const ValueParamsSchema = z.object({ id: z.uuid() });

/**
 * Corrections are annotations beside the extracted value, never an edit of it.
 * `value` is what the reviewer typed; the server normalizes it for the field
 * type (e.g. "$6,126.45" -> { cents: 612645, currency: "USD" }).
 */
export const ReviewRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().trim().max(2000).optional() }),
  z.object({
    action: z.literal("correct"),
    value: z.union([z.string().trim().min(1).max(500), z.number()]),
    currency: z.string().trim().length(3).optional(),
    note: z.string().trim().max(2000).optional(),
  }),
]);
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

// --------------------------------------------------------------- responses

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Counts per review state. Every value is in exactly one bucket: `gaps` are
 * gaps still waiting for a reviewer; a reviewed gap counts as approved /
 * corrected / carriedOver like any other value.
 */
export const ProgressSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  gaps: z.number().int(),
  approved: z.number().int(),
  corrected: z.number().int(),
  carriedOver: z.number().int(),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ReviewDtoSchema = z.object({
  id: z.string(),
  action: ReviewActionSchema,
  correctedValue: FieldValueSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  /** Set when this review was carried over from an earlier version's review. */
  carriedFrom: z.object({ reviewId: z.string(), versionNo: z.number().int() }).nullable(),
});
export type ReviewDto = z.infer<typeof ReviewDtoSchema>;

export const EvidenceSchema = z.object({
  text: z.string(),
  /** Offsets into the version's parsedText. */
  start: z.number().int(),
  end: z.number().int(),
});

export const GapSchema = z.object({
  reason: GapReasonSchema,
  detail: z.string().nullable(),
  /** The model's quote when it could not be verified; for debugging only. */
  unverifiedQuote: z.string().nullable(),
});

export const PreviousValueSchema = z.object({
  valueId: z.string(),
  versionNo: z.number().int(),
  value: FieldValueSchema.nullable(),
  gap: GapSchema.nullable(),
  review: ReviewDtoSchema.nullable(),
});

export const ValueDtoSchema = z.object({
  id: z.string(),
  field: z.string(),
  fieldType: FieldTypeSchema,
  /** What the model extracted and we verified; null for a gap. Never changes. */
  extractedValue: FieldValueSchema.nullable(),
  /** Latest correction ?? extracted value. */
  effectiveValue: FieldValueSchema.nullable(),
  evidence: EvidenceSchema.nullable(),
  gap: GapSchema.nullable(),
  reviewState: ReviewStateSchema,
  review: ReviewDtoSchema.nullable(),
  /** Same field in the version this one was compared against on re-extraction. */
  previous: PreviousValueSchema.nullable(),
});
export type ValueDto = z.infer<typeof ValueDtoSchema>;

export const VersionSummarySchema = z.object({
  id: z.string(),
  versionNo: z.number().int(),
  status: VersionStatusSchema,
  fileName: z.string(),
  createdAt: z.string(),
});
export type VersionSummary = z.infer<typeof VersionSummarySchema>;

export const DocumentSummarySchema = z.object({
  id: z.string(),
  type: DocumentTypeSchema,
  title: z.string(),
  /** The current version's status. */
  status: VersionStatusSchema,
  currentVersion: VersionSummarySchema,
  versionCount: z.number().int(),
  progress: ProgressSchema,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentListResponseSchema = z.object({ documents: z.array(DocumentSummarySchema) });
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const VersionDetailSchema = z.object({
  document: DocumentSummarySchema.extend({ versions: z.array(VersionSummarySchema) }),
  version: VersionSummarySchema.extend({
    isCurrent: z.boolean(),
    attempt: z.number().int(),
    attemptsLeft: z.number().int(),
    lastError: z.string().nullable(),
    /** The exact text evidence offsets point into; null until parsed. */
    parsedText: z.string().nullable(),
  }),
  values: z.array(ValueDtoSchema),
  progress: ProgressSchema,
});
export type VersionDetail = z.infer<typeof VersionDetailSchema>;

export const UploadResponseSchema = z.object({
  document: DocumentSummarySchema,
  version: VersionSummarySchema,
  /** True when the file was identical to the current version and nothing new was created. */
  duplicate: z.boolean(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
