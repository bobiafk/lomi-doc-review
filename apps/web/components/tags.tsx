import type { DocumentType, GapReason, ReviewState, VersionStatus } from "@lomi/shared";
import { GAP_LABEL, humanizeType, STATUS_LABEL } from "../lib/format";

const STATUS_COLOR: Record<VersionStatus, string> = {
  queued: "gray",
  extracting: "blue",
  extracted: "green",
  failed: "red",
  superseded: "gray",
};

export function StatusTag({ status }: { status: VersionStatus }) {
  return (
    <span className={`tag ${STATUS_COLOR[status]}`}>
      {(status === "queued" || status === "extracting") && <span className="pulse" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

const REVIEW: Record<ReviewState, { label: string; color: string }> = {
  pending: { label: "Needs review", color: "orange" },
  approved: { label: "Approved", color: "green" },
  corrected: { label: "Corrected", color: "purple" },
  carried_over: { label: "Carried over", color: "blue" },
};

export function ReviewTag({ state, gap }: { state: ReviewState; gap: GapReason | null }) {
  if (state === "pending" && gap) return <span className="tag yellow">Gap · {GAP_LABEL[gap].title}</span>;
  return <span className={`tag ${REVIEW[state].color}`}>{REVIEW[state].label}</span>;
}

export const TYPE_ICON: Record<DocumentType, string> = { invoice: "🧾", lease: "🏠", market_report: "📈" };

export function TypeTag({ type }: { type: DocumentType }) {
  return <span className="tag gray">{humanizeType(type)}</span>;
}
