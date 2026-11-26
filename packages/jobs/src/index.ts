import { Queue, type ConnectionOptions } from "bullmq";
import { z } from "zod";

/**
 * The extraction queue is a doorbell, not a ledger: a job only says "look at
 * version X". Postgres holds the status, attempts, lease and outcome, so a
 * lost, duplicated or flushed job changes nothing; the worker's reconciler
 * re-rings the bell for anything Postgres says still needs work.
 */
export const EXTRACTION_QUEUE = "extraction";

export const ExtractionJobSchema = z.object({ versionId: z.uuid() });
export type ExtractionJob = z.infer<typeof ExtractionJobSchema>;

export type ExtractionQueue = Queue<ExtractionJob>;

export function createExtractionQueue(connection: ConnectionOptions): ExtractionQueue {
  return new Queue<ExtractionJob>(EXTRACTION_QUEUE, { connection });
}

/**
 * jobId = versionId, so ringing twice while a job is waiting or running is a
 * no-op. Finished jobs are removed so the same version can be rung again later
 * (retry, recovery).
 */
export async function enqueueExtraction(queue: ExtractionQueue, versionId: string, delayMs = 0): Promise<void> {
  await queue.add(
    "extract",
    { versionId },
    { jobId: versionId, delay: delayMs, removeOnComplete: true, removeOnFail: true, attempts: 1 },
  );
}
