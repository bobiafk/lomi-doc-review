import type { PrismaClient } from "@lomi/db";

export interface ReconcileResult {
  /** Versions whose doorbell was rung (again). */
  enqueued: string[];
  /** Versions whose lease expired with no automatic attempts left. */
  failed: string[];
  /** Runs whose worker died before finishing. */
  abandonedRuns: number;
}

/**
 * Makes Redis agree with Postgres. Runs at worker startup and on an interval,
 * so a restart, a killed container or a Redis FLUSHALL never strands work:
 * anything Postgres says still needs extracting is enqueued again (jobId =
 * versionId makes that idempotent), and anything that can't be retried
 * automatically any more becomes a visible failure.
 */
export async function reconcile(
  prisma: PrismaClient,
  enqueue: (versionId: string, delayMs: number) => Promise<void>,
): Promise<ReconcileResult> {
  const failed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE document_versions
    SET status = 'failed',
        last_error = 'Extraction did not finish: the worker stopped (crash, restart or timeout) and no automatic attempts are left. Retry to try again.',
        lease_expires_at = NULL,
        updated_at = now()
    WHERE status = 'extracting' AND lease_expires_at < now() AND attempts_left = 0
    RETURNING id`;

  const abandonedRuns = await prisma.$executeRaw`
    UPDATE extraction_runs r
    SET outcome = 'abandoned',
        error = 'worker stopped before finishing; its lease expired',
        finished_at = now()
    FROM document_versions v
    WHERE r.version_id = v.id
      AND r.outcome = 'running'
      AND (v.attempt > r.attempt OR v.lease_expires_at IS NULL OR v.lease_expires_at < now())`;

  const due = await prisma.$queryRaw<{ id: string; delay_ms: number }[]>`
    SELECT id, GREATEST(0, EXTRACT(EPOCH FROM (available_at - now())) * 1000)::int AS delay_ms
    FROM document_versions
    WHERE status = 'queued'
       OR (status = 'extracting' AND lease_expires_at < now() AND attempts_left > 0)
    ORDER BY created_at`;

  const enqueued: string[] = [];
  for (const { id, delay_ms } of due) {
    await enqueue(id, delay_ms);
    enqueued.push(id);
  }

  return { enqueued, failed: failed.map((f) => f.id), abandonedRuns };
}
