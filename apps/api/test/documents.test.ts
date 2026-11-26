import type { PrismaClient } from "@lomi/db";
import { createTestDatabase, type TestDatabase } from "@lomi/db/testing";
import {
  DocumentListResponseSchema,
  ErrorResponseSchema,
  ProgressSchema,
  UploadResponseSchema,
  VersionDetailSchema,
} from "@lomi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixturePdf, INVOICE, invoiceV1Values, markExtracted, seedFixtures, testApp, upload } from "./helpers.js";

let db: TestDatabase;
let prisma: PrismaClient;

beforeEach(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  await seedFixtures(prisma);
});
afterEach(() => db.drop());

const invoicePdf = { name: "invoice-001.pdf", bytes: fixturePdf("invoice-001.pdf") };
const invoiceV2Pdf = { name: "invoice-001.v2.pdf", bytes: fixturePdf("invoice-001.v2.pdf") };

async function v1Id() {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: INVOICE } });
  return doc.currentVersionId!;
}

describe("POST /documents", () => {
  it("commits a queued version, then enqueues it, and answers 202 without waiting", async () => {
    const { app, enqueued } = testApp(prisma);
    const res = await upload(app, "/documents", invoicePdf, { type: "invoice", title: "My invoice" });

    expect(res.statusCode).toBe(202);
    const body = UploadResponseSchema.parse(res.json());
    expect(body.document).toMatchObject({ type: "invoice", title: "My invoice", status: "queued", versionCount: 1 });
    expect(body.version).toMatchObject({ versionNo: 1, status: "queued", fileName: "invoice-001.pdf" });
    expect(enqueued).toEqual([body.version.id]);

    const stored = await prisma.documentVersion.findUniqueOrThrow({ where: { id: body.version.id } });
    expect(stored.status).toBe("queued");
    expect(Buffer.from(stored.fileBytes)).toEqual(Buffer.from(invoicePdf.bytes));
  });

  it("still succeeds when Redis is down: the version is committed for the reconciler", async () => {
    const { app } = testApp(prisma, async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await upload(app, "/documents", invoicePdf, { type: "invoice" });
    expect(res.statusCode).toBe(202);
    const { version } = UploadResponseSchema.parse(res.json());
    expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: version.id } })).status).toBe("queued");
  });

  it("defaults the title to the file name", async () => {
    const { app } = testApp(prisma);
    const res = await upload(app, "/documents", invoicePdf, { type: "invoice" });
    expect(UploadResponseSchema.parse(res.json()).document.title).toBe("invoice-001");
  });

  it.each([
    ["an unknown type", invoicePdf, { type: "receipt" }, 400, "invalid_request"],
    ["no type", invoicePdf, {}, 400, "invalid_request"],
    ["no file", null, { type: "invoice" }, 400, "file_required"],
    ["a file that is not a PDF", { name: "x.pdf", bytes: new TextEncoder().encode("hello") }, { type: "invoice" }, 415, "not_a_pdf"],
  ])("rejects %s with a consistent error body", async (_name, file, fields, status, code) => {
    const { app, enqueued } = testApp(prisma);
    const res = await upload(app, "/documents", file, fields);
    expect(res.statusCode).toBe(status);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe(code);
    expect(enqueued).toEqual([]);
  });

  it("rejects a JSON body", async () => {
    const { app } = testApp(prisma);
    const res = await app.inject({ method: "POST", url: "/documents", payload: { type: "invoice" } });
    expect(res.statusCode).toBe(415);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("unsupported_media_type");
  });
});

describe("POST /documents/:id/versions", () => {
  it("adds version 2 as current; an extracted v1 stays extracted", async () => {
    await markExtracted(prisma, await v1Id(), invoiceV1Values);
    const { app, enqueued } = testApp(prisma);
    const res = await upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf);

    expect(res.statusCode).toBe(202);
    const body = UploadResponseSchema.parse(res.json());
    expect(body.version.versionNo).toBe(2);
    expect(body.document.currentVersion.versionNo).toBe(2);
    expect(enqueued).toEqual([body.version.id]);
    expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: body.version.id } })).status).toBe("queued");
    const v1 = await prisma.documentVersion.findUniqueOrThrow({
      where: { documentId_versionNo: { documentId: INVOICE, versionNo: 1 } },
    });
    expect(v1.status).toBe("extracted");
  });

  it("supersedes a version that is still queued or extracting", async () => {
    const { app } = testApp(prisma);
    await upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf);
    const v1 = await prisma.documentVersion.findUniqueOrThrow({
      where: { documentId_versionNo: { documentId: INVOICE, versionNo: 1 } },
    });
    expect(v1.status).toBe("superseded");
  });

  it("treats re-uploading the current file as a no-op (double upload)", async () => {
    const { app, enqueued } = testApp(prisma);
    const first = await upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf);
    const second = await upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(UploadResponseSchema.parse(second.json())).toMatchObject({ duplicate: true, version: { versionNo: 2 } });
    expect(enqueued).toHaveLength(1);
    expect(await prisma.documentVersion.count({ where: { documentId: INVOICE } })).toBe(2);
  });

  it("serializes concurrent uploads of different files into distinct version numbers", async () => {
    const { app } = testApp(prisma);
    const results = await Promise.all([
      upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf),
      upload(app, `/documents/${INVOICE}/versions`, { name: "lease.pdf", bytes: fixturePdf("lease-excerpt-001.pdf") }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
    const versions = await prisma.documentVersion.findMany({ where: { documentId: INVOICE }, orderBy: { versionNo: "asc" } });
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [1, "superseded"],
      [2, "superseded"],
      [3, "queued"],
    ]);
  });

  it("404s for an unknown document", async () => {
    const { app } = testApp(prisma);
    const res = await upload(app, "/documents/doc-nope/versions", invoiceV2Pdf);
    expect(res.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("document_not_found");
  });
});

describe("GET /documents and /documents/:id", () => {
  it("lists every document with status, current version and progress", async () => {
    await markExtracted(prisma, await v1Id(), invoiceV1Values);
    const { app } = testApp(prisma);
    const res = await app.inject({ method: "GET", url: "/documents" });
    const { documents } = DocumentListResponseSchema.parse(res.json());
    expect(documents.map((d) => [d.id, d.status])).toEqual([
      ["doc-invoice-001", "extracted"],
      ["doc-lease-001", "queued"],
      ["doc-report-001", "queued"],
    ]);
    expect(documents[0]?.progress).toEqual({ total: 5, pending: 5, gaps: 0, approved: 0, corrected: 0, carriedOver: 0 });
  });

  it("returns the current version with values, evidence, gaps and parsed text", async () => {
    await markExtracted(prisma, await v1Id(), [
      ...invoiceV1Values.slice(0, 4),
      { field: "total_amount", gapReason: "evidence_not_found" },
    ]);
    const { app } = testApp(prisma);
    const detail = VersionDetailSchema.parse((await app.inject({ method: "GET", url: `/documents/${INVOICE}` })).json());

    expect(detail.version).toMatchObject({ versionNo: 1, isCurrent: true, status: "extracted" });
    expect(detail.values.map((v) => v.field)).toEqual([
      "invoice_number",
      "issue_date",
      "due_date",
      "vendor_name",
      "total_amount",
    ]);
    const invoiceNumber = detail.values[0]!;
    expect(invoiceNumber).toMatchObject({ fieldType: "string", extractedValue: "INV-2025-0847", reviewState: "pending" });
    expect(detail.version.parsedText!.slice(invoiceNumber.evidence!.start, invoiceNumber.evidence!.end)).toBe(
      "Invoice Number: INV-2025-0847",
    );
    expect(detail.values[4]).toMatchObject({
      extractedValue: null,
      evidence: null,
      gap: { reason: "evidence_not_found" },
      reviewState: "pending",
    });
    expect(detail.progress).toEqual({ total: 5, pending: 4, gaps: 1, approved: 0, corrected: 0, carriedOver: 0 });
  });

  it("shows a queued document with no values yet, and 404s an unknown one", async () => {
    const { app } = testApp(prisma);
    const detail = VersionDetailSchema.parse((await app.inject({ method: "GET", url: "/documents/doc-lease-001" })).json());
    expect(detail.version.status).toBe("queued");
    expect(detail.values).toEqual([]);
    const missing = await app.inject({ method: "GET", url: "/documents/doc-nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("serves historical versions after a new one exists", async () => {
    await markExtracted(prisma, await v1Id(), invoiceV1Values);
    const { app } = testApp(prisma);
    await upload(app, `/documents/${INVOICE}/versions`, invoiceV2Pdf);

    const v1 = VersionDetailSchema.parse((await app.inject({ method: "GET", url: `/documents/${INVOICE}/versions/1` })).json());
    expect(v1.version).toMatchObject({ versionNo: 1, isCurrent: false, status: "extracted" });
    expect(v1.values).toHaveLength(5);
    expect(v1.document.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect((await app.inject({ method: "GET", url: `/documents/${INVOICE}/versions/9` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/documents/${INVOICE}/versions/abc` })).statusCode).toBe(400);
  });

  it("GET /documents/:id/progress returns the counts", async () => {
    await markExtracted(prisma, await v1Id(), invoiceV1Values);
    const { app } = testApp(prisma);
    const res = await app.inject({ method: "GET", url: `/documents/${INVOICE}/progress` });
    expect(ProgressSchema.parse(res.json())).toMatchObject({ total: 5, pending: 5 });
  });
});

describe("POST /documents/:id/retry", () => {
  it("re-queues a failed current version with a fresh attempt budget", async () => {
    const id = await v1Id();
    await prisma.documentVersion.update({
      where: { id },
      data: { status: "failed", attempt: 3, attemptsLeft: 0, lastError: "LLM request failed" },
    });
    const { app, enqueued } = testApp(prisma);
    const res = await app.inject({ method: "POST", url: `/documents/${INVOICE}/retry` });
    expect(res.statusCode).toBe(202);
    expect(enqueued).toEqual([id]);
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(version).toMatchObject({ status: "queued", attempt: 3, attemptsLeft: 3, lastError: null });
  });

  it("refuses to retry a version that has not failed", async () => {
    const { app, enqueued } = testApp(prisma);
    const res = await app.inject({ method: "POST", url: `/documents/${INVOICE}/retry` });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("not_failed");
    expect(enqueued).toEqual([]);
  });
});

describe("errors", () => {
  it("unknown routes get the same error shape", async () => {
    const { app } = testApp(prisma);
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("not_found");
  });
});
