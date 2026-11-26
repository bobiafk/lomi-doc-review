import type { Progress } from "@lomi/shared";
import { reviewedCount } from "../lib/review";

/** Reviewed share of all values, split by how they got reviewed. */
export function ProgressBar({ progress }: { progress: Progress }) {
  if (progress.total === 0) return <span className="faint">—</span>;
  const pct = (n: number) => `${(n / progress.total) * 100}%`;
  return (
    <div className="progress" title={`${progress.approved} approved · ${progress.corrected} corrected · ${progress.carriedOver} carried over · ${progress.pending} pending · ${progress.gaps} gaps`}>
      <div className="progress-track">
        <span className="seg-approved" style={{ width: pct(progress.approved) }} />
        <span className="seg-corrected" style={{ width: pct(progress.corrected) }} />
        <span className="seg-carried" style={{ width: pct(progress.carriedOver) }} />
      </div>
      <span className="progress-label">
        {reviewedCount(progress)}/{progress.total}
      </span>
    </div>
  );
}
