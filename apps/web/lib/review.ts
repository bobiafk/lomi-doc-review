import type { DocumentSummary, Progress, ValueDto, VersionStatus } from "@lomi/shared";

/** Statuses that will change on their own; only these are worth polling for. */
export const IN_FLIGHT: readonly VersionStatus[] = ["queued", "extracting"];

export const POLL_MS = 2_000;

export function isInFlight(status: VersionStatus): boolean {
  return IN_FLIGHT.includes(status);
}

/** List polling: on while any document is queued or extracting, off otherwise. */
export function listRefetchInterval(documents: DocumentSummary[] | undefined): number | false {
  return documents?.some((d) => isInFlight(d.status)) ? POLL_MS : false;
}

export interface ValueGroups {
  /** Pending values and gaps: what the reviewer must act on. Changed values first. */
  attention: ValueDto[];
  carriedOver: ValueDto[];
  reviewed: ValueDto[];
}

/** Detail ordering: what needs attention first, then carried over, then done. */
export function groupValues(values: ValueDto[]): ValueGroups {
  const attention = values.filter((v) => v.reviewState === "pending");
  // Within "needs attention": values that changed since the last version lead,
  // then ordinary pending values, then gaps.
  const rank = (v: ValueDto) => (v.previous && v.gap === null ? 0 : v.gap === null ? 1 : 2);
  return {
    attention: attention.map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i).map(({ v }) => v),
    carriedOver: values.filter((v) => v.reviewState === "carried_over"),
    reviewed: values.filter((v) => v.reviewState === "approved" || v.reviewState === "corrected"),
  };
}

export function needsAttention(progress: Progress): number {
  return progress.pending + progress.gaps;
}

export function reviewedCount(progress: Progress): number {
  return progress.approved + progress.corrected + progress.carriedOver;
}

/** One line a reviewer can read in a glance. */
export function attentionSummary(progress: Progress, status: VersionStatus): string {
  if (status === "queued") return "Waiting for extraction";
  if (status === "extracting") return "Extracting values…";
  if (status === "failed") return "Extraction failed";
  if (status === "superseded") return "Replaced by a newer version";
  if (progress.total === 0) return "No values";
  const todo = needsAttention(progress);
  if (todo === 0) return `All ${progress.total} values reviewed`;
  const parts = [`${todo} of ${progress.total} need review`];
  if (progress.gaps > 0) parts.push(`${progress.gaps} gap${progress.gaps === 1 ? "" : "s"}`);
  if (progress.carriedOver > 0) parts.push(`${progress.carriedOver} carried over`);
  return parts.join(" · ");
}
