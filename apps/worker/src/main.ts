import { createPrismaClient } from "@lomi/db";
import { createExtractionQueue, enqueueExtraction, EXTRACTION_QUEUE, ExtractionJobSchema } from "@lomi/jobs";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { AnthropicExtractionLlm } from "./anthropic-llm.js";
import { CannedLlm } from "./canned-llm.js";
import { loadEnv } from "./env.js";
import { processVersion, type WorkerDeps } from "./process-version.js";
import { reconcile } from "./reconciler.js";

const env = loadEnv();
const log = (message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: message, ...extra }));

const prisma = createPrismaClient(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = createExtractionQueue(connection);

const deps: WorkerDeps = {
  prisma,
  llm:
    env.EXTRACTION_LLM === "canned"
      ? new CannedLlm(env.CANNED_DELAY_MS)
      : new AnthropicExtractionLlm(env.ANTHROPIC_MODEL, env.ANTHROPIC_API_KEY),
  enqueue: (versionId, delayMs) => enqueueExtraction(queue, versionId, delayMs),
  leaseMs: env.LEASE_MS,
  heartbeatMs: env.HEARTBEAT_MS,
  log,
};

// The job only names a version; Postgres decides whether there is work to do.
const worker = new Worker(
  EXTRACTION_QUEUE,
  async (job) => {
    const { versionId } = ExtractionJobSchema.parse(job.data);
    const result = await processVersion(deps, versionId);
    log("job done", { versionId, result });
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);
worker.on("error", (error) => log("worker error", { error: error.message }));

async function reconcileOnce(): Promise<void> {
  try {
    const result = await reconcile(prisma, deps.enqueue);
    if (result.enqueued.length || result.failed.length || result.abandonedRuns) log("reconciled", { ...result });
  } catch (error) {
    // Redis or Postgres briefly unavailable: try again next tick.
    log("reconcile failed", { error: (error as Error).message });
  }
}

await reconcileOnce();
const timer = setInterval(() => void reconcileOnce(), env.RECONCILE_MS);
log("worker started", { model: deps.llm.model, concurrency: env.WORKER_CONCURRENCY });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log("shutting down", { signal });
    clearInterval(timer);
    // In-flight attempts that don't finish in time just let their lease
    // expire; the next worker's reconciler picks them up.
    void Promise.allSettled([worker.close(), queue.close()])
      .then(() => Promise.allSettled([prisma.$disconnect(), connection.quit()]))
      .then(() => process.exit(0));
  });
}
