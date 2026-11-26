import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing/test-db.js";

let db: TestDatabase;
let prisma: PrismaClient;
let versionId: string;
let runId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  await prisma.document.create({ data: { id: "doc-constraints", type: "invoice", title: "t" } });
  const version = await prisma.documentVersion.create({
    data: {
      documentId: "doc-constraints",
      versionNo: 1,
      fileName: "x.pdf",
      fileBytes: Buffer.from("x"),
      sha256: "0".repeat(64),
      parsedText: "Invoice Number: INV-1",
    },
  });
  versionId = version.id;
  const run = await prisma.extractionRun.create({ data: { versionId, attempt: 1, model: "test" } });
  runId = run.id;
});
afterAll(() => db.drop());

const evidenced = (field: string) => ({
  versionId: "",
  runId: "",
  field,
  value: "INV-1",
  evidenceText: "INV-1",
  evidenceStart: 16,
  evidenceEnd: 21,
});

describe("extracted_values: evidence or gap", () => {
  it("accepts a fully evidenced value and a gap with a reason", async () => {
    await prisma.extractedValue.create({ data: { ...evidenced("invoice_number"), versionId, runId } });
    await prisma.extractedValue.create({
      data: { versionId, runId, field: "due_date", gapReason: "not_found: no due date stated" },
    });
  });

  it("rejects a value without evidence", async () => {
    await expect(
      prisma.extractedValue.create({ data: { versionId, runId, field: "f1", value: "INV-1" } }),
    ).rejects.toThrow(/extracted_values_evidence_or_gap/);
  });

  it("rejects a gap that still carries a value", async () => {
    await expect(
      prisma.extractedValue.create({
        data: { ...evidenced("f2"), versionId, runId, gapReason: "evidence_not_found" },
      }),
    ).rejects.toThrow(/extracted_values_evidence_or_gap/);
  });

  it("rejects JSON null as a value (a gap must be SQL NULL with a reason)", async () => {
    await expect(
      prisma.extractedValue.create({
        data: { ...evidenced("f3"), versionId, runId, value: Prisma.JsonNull },
      }),
    ).rejects.toThrow(/extracted_values_evidence_or_gap/);
  });

  it("rejects a second value for the same (version, field)", async () => {
    await expect(
      prisma.extractedValue.create({ data: { ...evidenced("invoice_number"), versionId, runId } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("reviews: correction model", () => {
  it("requires a corrected value for corrections and forbids one for approvals", async () => {
    const value = await prisma.extractedValue.findUniqueOrThrow({
      where: { versionId_field: { versionId, field: "invoice_number" } },
    });
    await prisma.review.create({ data: { valueId: value.id, action: "approve" } });
    await prisma.review.create({ data: { valueId: value.id, action: "correct", correctedValue: "INV-2" } });

    await expect(
      prisma.review.create({ data: { valueId: value.id, action: "correct" } }),
    ).rejects.toThrow(/reviews_correction_has_value/);
    await expect(
      prisma.review.create({ data: { valueId: value.id, action: "approve", correctedValue: "INV-2" } }),
    ).rejects.toThrow(/reviews_correction_has_value/);
  });
});

describe("document_versions", () => {
  it("rejects status extracting without a lease", async () => {
    await expect(
      prisma.documentVersion.update({ where: { id: versionId }, data: { status: "extracting" } }),
    ).rejects.toThrow(/document_versions_extracting_has_lease/);
  });
});
