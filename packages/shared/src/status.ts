import { z } from "zod";

/** Lifecycle of a document version. Persisted in Postgres; Redis never holds it. */
export const VERSION_STATUSES = ["queued", "extracting", "extracted", "failed", "superseded"] as const;
export const VersionStatusSchema = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;

/** Review state of a value. Derived from the reviews table, never stored. */
export const REVIEW_STATES = ["pending", "approved", "corrected", "carried_over"] as const;
export const ReviewStateSchema = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const REVIEW_ACTIONS = ["approve", "correct"] as const;
export const ReviewActionSchema = z.enum(REVIEW_ACTIONS);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
