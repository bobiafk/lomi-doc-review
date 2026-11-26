import type { PrismaClient } from "@lomi/db";
import { createTestDatabase, type TestDatabase } from "@lomi/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processVersion } from "../src/process-version.js";
import { reconcile } from "../src/reconciler.js";
import { deps, FakeLlm, gate, invoiceV1Output, seedFixtures, versionId } from "./helpers.js";

let db: TestDatabase;
let prisma: PrismaClient;

beforeEach(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  await seedFixtures(prisma);
});
afterEach(() => db.drop());

function recorder() {
  const calls: [string, number][] = [];
  return { calls, enqueue: async (id: string, delayMs: number) => void calls.push([id, delayMs]) };
}

async function set(id: string, sql: "extracting-live" | "extracting-expired" | "exhausted" | "extracted" | "backing-off") {
  switch (sql) {
    case "extracting-live":
      await prisma.$executeRaw`UPDATE document_versions SET status = 'extracting', attempt = 1, attempts_left = 2, lease_expires_at = now() + interval '1 minute' WHERE id = ${id}::uuid`;
      break;
    case "extracting-expired":
      await prisma.$executeRaw`UPDATE document_versions SET status = 'extracting', attempt = 1, attempts_left = 2, lease_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;
      break;
    case "exhausted":
      await prisma.$executeRaw`UPDATE document_versions SET status = 'extracting', attempt = 3, attempts_left = 0, lease_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;
      break;
    case "extracted":
      await prisma.$executeRaw`UPDATE document_versions SET status = 'extracted' WHERE id = ${id}::uuid`;
      break;
    case "backing-off":
      await prisma.$executeRaw`UPDATE document_versions SET available_at = now() + interval '30 seconds' WHERE id = ${id}::uuid`;
      break;
  }
}

describe("reconcile", () => {
  it("rings the doorbell for every queued version, even with an empty Redis (fresh seed, FLUSHALL)", async () => {
    const { calls, enqueue } = recorder();
    const result = await reconcile(prisma, enqueue);
    expect(result.enqueued).toHaveLength(3);
    expect(calls.every(([, delay]) => delay === 0)).toBe(true);
  });

  it("re-enqueues expired leases, leaves live ones alone, fails exhausted ones, skips finished ones", async () => {
    const [invoice, lease, report] = await Promise.all([
      versionId(prisma, "doc-invoice-001"),
      versionId(prisma, "doc-lease-001"),
      versionId(prisma, "doc-report-001"),
    ]);
    await set(invoice, "extracting-live");
    await set(lease, "extracting-expired");
    await set(report, "exhausted");

    const { calls, enqueue } = recorder();
    const result = await reconcile(prisma, enqueue);

    expect(calls.map(([id]) => id)).toEqual([lease]);
    expect(result.failed).toEqual([report]);
    const failed = await prisma.documentVersion.findUniqueOrThrow({ where: { id: report } });
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toMatch(/worker stopped/);

    await set(lease, "extracted");
    expect((await reconcile(prisma, recorder().enqueue)).enqueued).toEqual([]);
  });

  it("respects backoff by enqueueing with the remaining delay", async () => {
    const invoice = await versionId(prisma, "doc-invoice-001");
    await set(invoice, "backing-off");
    const { calls, enqueue } = recorder();
    await reconcile(prisma, enqueue);
    const [, delay] = calls.find(([id]) => id === invoice)!;
    expect(delay).toBeGreaterThan(25_000);
  });

  it("recovers a version whose worker died mid-extraction, and marks the dead run abandoned", async () => {
    const invoice = await versionId(prisma, "doc-invoice-001");
    const g = gate();
    const dying = processVersion(
      deps(prisma, new FakeLlm(async (_p, signal) => g.wait(signal).then(invoiceV1Output))),
      invoice,
    );
    await g.reached;
    // The "worker" dies: it will never heartbeat or commit; its lease lapses.
    await prisma.$executeRaw`UPDATE document_versions SET lease_expires_at = now() - interval '1 second' WHERE id = ${invoice}::uuid`;

    const { calls, enqueue } = recorder();
    const result = await reconcile(prisma, enqueue);
    expect(calls.map(([id]) => id)).toContain(invoice);
    expect(result.abandonedRuns).toBe(1);

    // The doorbell rings; a fresh worker completes it.
    expect(await processVersion(deps(prisma, new FakeLlm(invoiceV1Output)), invoice)).toBe("extracted");
    const runs = await prisma.extractionRun.findMany({ where: { versionId: invoice }, orderBy: { attempt: "asc" } });
    expect(runs.map((r) => r.outcome)).toEqual(["abandoned", "succeeded"]);

    g.release();
    expect(await dying).toBe("fenced_out");
    expect(await prisma.extractedValue.count({ where: { versionId: invoice } })).toBe(5);
  });
});
