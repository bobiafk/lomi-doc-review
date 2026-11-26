import type { PrismaClient } from "@lomi/db";
import { createTestDatabase, type TestDatabase } from "@lomi/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "../src/llm.js";
import { processVersion } from "../src/process-version.js";
import {
  deps,
  FakeLlm,
  gate,
  INVOICE,
  invoiceV1Output,
  invoiceV2Output,
  seedFixtures,
  uploadVersion,
  versionId,
} from "./helpers.js";

let db: TestDatabase;
let prisma: PrismaClient;
let v1: string;

beforeEach(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  await seedFixtures(prisma);
  v1 = await versionId(prisma, INVOICE);
});
afterEach(() => db.drop());

async function expireLease(id: string) {
  await prisma.$executeRaw`UPDATE document_versions SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;
}

describe("processVersion: happy path", () => {
  it("parses, extracts, validates and commits values with evidence offsets, logging the run", async () => {
    const result = await processVersion(deps(prisma, new FakeLlm(invoiceV1Output)), v1);
    expect(result).toBe("extracted");

    const version = await prisma.documentVersion.findUniqueOrThrow({
      where: { id: v1 },
      include: { values: true, runs: true },
    });
    expect(version.status).toBe("extracted");
    expect(version.attempt).toBe(1);
    expect(version.leaseExpiresAt).toBeNull();
    expect(version.parsedText).toContain("Invoice Number: INV-2025-0847");
    expect(version.values).toHaveLength(5);
    for (const value of version.values) {
      expect(value.gapReason, value.field).toBeNull();
      expect(version.parsedText!.slice(value.evidenceStart!, value.evidenceEnd!)).toBe(value.evidenceText);
    }

    const [run] = version.runs;
    expect(run).toMatchObject({ attempt: 1, outcome: "succeeded", model: "fake-model-answered", inputTokens: 100 });
    expect(JSON.parse(run!.prompt!)).toHaveProperty("schema");
    expect(run!.rawResponse).toMatchObject({ fake: true });
    expect(run!.finishedAt).not.toBeNull();
  });
});

describe("processVersion: the same version twice never duplicates values", () => {
  it("a second run after success does nothing", async () => {
    const llm = new FakeLlm(invoiceV1Output);
    expect(await processVersion(deps(prisma, llm), v1)).toBe("extracted");
    expect(await processVersion(deps(prisma, llm), v1)).toBe("not_claimed");
    expect(llm.calls).toBe(1);
    expect(await prisma.extractedValue.count({ where: { versionId: v1 } })).toBe(5);
    expect(await prisma.extractionRun.count({ where: { versionId: v1 } })).toBe(1);
  });

  it("two concurrent runs: exactly one claims", async () => {
    const g = gate();
    const llm = new FakeLlm(async (_p, signal) => {
      await g.wait(signal);
      return invoiceV1Output();
    });
    const first = processVersion(deps(prisma, llm), v1);
    await g.reached;
    const second = await processVersion(deps(prisma, llm), v1);
    g.release();
    expect([await first, second]).toEqual(["extracted", "not_claimed"]);
    expect(await prisma.extractedValue.count({ where: { versionId: v1 } })).toBe(5);
  });

  it("a worker whose lease expired cannot commit after another attempt took over", async () => {
    const slow = gate();
    const slowLlm = new FakeLlm(async (_p, signal) => {
      await slow.wait(signal);
      return invoiceV1Output();
    });
    const stale = processVersion(deps(prisma, slowLlm), v1);
    await slow.reached;

    await expireLease(v1); // worker A "hangs" past its lease
    expect(await processVersion(deps(prisma, new FakeLlm(invoiceV1Output)), v1)).toBe("extracted");

    slow.release(); // A wakes up with a result
    expect(await stale).toBe("fenced_out");

    expect(await prisma.extractedValue.count({ where: { versionId: v1 } })).toBe(5);
    const runs = await prisma.extractionRun.findMany({ where: { versionId: v1 }, orderBy: { attempt: "asc" } });
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "fenced_out"],
      [2, "succeeded"],
    ]);
  });
});

describe("processVersion: supersede", () => {
  it("a new version arriving mid-extraction discards the old result at commit", async () => {
    const g = gate();
    const llm = new FakeLlm(async (_p, signal) => {
      await g.wait(signal);
      return invoiceV1Output();
    });
    const inFlight = processVersion(deps(prisma, llm), v1);
    await g.reached;

    const v2 = await uploadVersion(prisma, INVOICE, "invoice-001.v2.pdf");
    g.release();

    expect(await inFlight).toBe("superseded");
    expect(await prisma.extractedValue.count({ where: { versionId: v1 } })).toBe(0);
    const run = await prisma.extractionRun.findFirstOrThrow({ where: { versionId: v1 } });
    expect(run.outcome).toBe("superseded");
    expect(run.rawResponse).toMatchObject({ fake: true }); // still logged
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: INVOICE } });
    expect(doc.currentVersionId).toBe(v2);
  });

  it("the heartbeat notices the supersede and aborts the LLM call early", async () => {
    const g = gate();
    let aborted = false;
    const llm = new FakeLlm(async (_p, signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      await g.wait(signal); // never released: only an abort ends it
      return invoiceV1Output();
    });
    const inFlight = processVersion(deps(prisma, llm, { heartbeatMs: 25 }), v1);
    await g.reached;
    await uploadVersion(prisma, INVOICE, "invoice-001.v2.pdf");

    expect(await inFlight).toBe("superseded");
    expect(aborted).toBe(true);
  });
});

describe("processVersion: failure is a state", () => {
  it("a malformed model response leaves the version failed with the error and the raw response", async () => {
    const result = await processVersion(deps(prisma, new FakeLlm(() => ({ fields: "nope" }))), v1);
    expect(result).toBe("failed");
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 }, include: { runs: true } });
    expect(version.status).toBe("failed");
    expect(version.lastError).toMatch(/fields/);
    expect(version.leaseExpiresAt).toBeNull();
    expect(version.runs[0]).toMatchObject({ outcome: "failed", rawResponse: { fake: true } });
  });

  it("a file that is not a PDF fails without calling the LLM", async () => {
    const id = await uploadVersion(prisma, INVOICE, new TextEncoder().encode("definitely not a pdf"));
    const llm = new FakeLlm(invoiceV1Output);
    expect(await processVersion(deps(prisma, llm), id)).toBe("failed");
    expect(llm.calls).toBe(0);
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(version.lastError).toMatch(/could not parse PDF/);
  });

  it("a refusal fails immediately, with no automatic retry", async () => {
    const llm = new FakeLlm(() => {
      throw new LlmError("model declined the request (cyber)", false);
    });
    expect(await processVersion(deps(prisma, llm), v1)).toBe("failed");
    expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 } })).attemptsLeft).toBe(2);
  });

  it("a transient error backs off and re-queues until automatic attempts run out", async () => {
    const enqueue = vi.fn(async () => {});
    const llm = new FakeLlm(() => {
      throw new LlmError("transient LLM error: overloaded", true);
    });
    const d = deps(prisma, llm, { enqueue });

    expect(await processVersion(d, v1)).toBe("requeued");
    let version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 } });
    expect(version).toMatchObject({ status: "queued", attemptsLeft: 2, lastError: expect.stringMatching(/overloaded/) });
    expect(enqueue).toHaveBeenCalledWith(v1, 0);

    expect(await processVersion(d, v1)).toBe("requeued");
    expect(await processVersion(d, v1)).toBe("failed");
    version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 } });
    expect(version).toMatchObject({ status: "failed", attempt: 3, attemptsLeft: 0 });
    expect(await processVersion(d, v1)).toBe("not_claimed");
    expect(await prisma.extractionRun.count({ where: { versionId: v1, outcome: "failed" } })).toBe(3);
  });

  it("backs off exponentially: the version is not claimable until available_at", async () => {
    const llm = new FakeLlm(() => {
      throw new LlmError("transient", true);
    });
    expect(await processVersion(deps(prisma, llm, { retryBaseMs: 60_000 }), v1)).toBe("requeued");
    expect(await processVersion(deps(prisma, llm), v1)).toBe("not_claimed");
  });
});

describe("processVersion: lease heartbeat", () => {
  it("extends the lease while the LLM call runs", async () => {
    const g = gate();
    const llm = new FakeLlm(async (_p, signal) => {
      await g.wait(signal);
      return invoiceV1Output();
    });
    const run = processVersion(deps(prisma, llm, { leaseMs: 2_000, heartbeatMs: 50 }), v1);
    await g.reached;
    const before = (await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 } })).leaseExpiresAt!;
    await new Promise((r) => setTimeout(r, 300));
    const after = (await prisma.documentVersion.findUniqueOrThrow({ where: { id: v1 } })).leaseExpiresAt!;
    g.release();
    expect(await run).toBe("extracted");
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("re-extraction with the real invoice v1 -> v2", () => {
  it("carries reviews for unchanged values; only due_date and total_amount go back to pending", async () => {
    expect(await processVersion(deps(prisma, new FakeLlm(invoiceV1Output)), v1)).toBe("extracted");
    const v1Values = await prisma.extractedValue.findMany({ where: { versionId: v1 } });
    for (const value of v1Values) {
      if (value.field === "vendor_name") {
        await prisma.review.create({
          data: { valueId: value.id, action: "correct", correctedValue: "Meridian Office Supplies, LLC", note: "legal name" },
        });
      } else {
        await prisma.review.create({ data: { valueId: value.id, action: "approve" } });
      }
    }

    const v2 = await uploadVersion(prisma, INVOICE, "invoice-001.v2.pdf");
    expect(await processVersion(deps(prisma, new FakeLlm(invoiceV2Output)), v2)).toBe("extracted");

    const v2Values = await prisma.extractedValue.findMany({
      where: { versionId: v2 },
      include: { reviews: true, previousValue: true },
    });
    const byField = Object.fromEntries(v2Values.map((v) => [v.field, v]));

    const carried = v2Values.filter((v) => v.reviews.length > 0).map((v) => v.field).sort();
    expect(carried).toEqual(["invoice_number", "issue_date", "vendor_name"]);
    const pending = v2Values.filter((v) => v.reviews.length === 0).map((v) => v.field).sort();
    expect(pending).toEqual(["due_date", "total_amount"]);

    for (const value of v2Values) {
      expect(value.previousValue?.field).toBe(value.field);
      expect(value.previousValue?.versionId).toBe(v1);
    }
    expect(byField["total_amount"]?.previousValue?.value).toEqual({ cents: 523029, currency: "USD" });
    expect(byField["vendor_name"]?.reviews[0]).toMatchObject({
      action: "correct",
      correctedValue: "Meridian Office Supplies, LLC",
      note: "legal name",
      carriedFromReviewId: expect.any(String),
    });

    // v1 and its reviews are untouched.
    expect(await prisma.review.count({ where: { value: { versionId: v1 } } })).toBe(5);
  });
});
