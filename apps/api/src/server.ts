import { createPrismaClient } from "@lomi/db";
import { createExtractionQueue, enqueueExtraction } from "@lomi/jobs";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
// Fail fast instead of buffering commands while Redis is down: an upload must
// not hang on the doorbell. The reconciler enqueues anything we miss.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
connection.on("error", () => {});
const queue = createExtractionQueue(connection);

const app = buildApp({
  prisma,
  enqueue: (versionId) => enqueueExtraction(queue, versionId),
  logger: true,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => Promise.allSettled([queue.close(), prisma.$disconnect(), connection.quit()]))
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.API_PORT, host: env.API_HOST });
