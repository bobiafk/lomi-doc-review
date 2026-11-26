import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/index.js";
import { seed } from "../src/seed.js";
import { createTestDatabase, type TestDatabase } from "../src/testing/test-db.js";

const fixturesDir = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const MANIFEST_IDS = ["doc-invoice-001", "doc-lease-001", "doc-report-001"];

let db: TestDatabase;
let prisma: PrismaClient;
beforeAll(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
});
afterAll(() => db.drop());

describe("seed", () => {
  it("inserts only version 1 of each manifest document, queued and current", async () => {
    const result = await seed(prisma, fixturesDir);
    expect(result.inserted.sort()).toEqual(MANIFEST_IDS);

    const docs = await prisma.document.findMany({
      include: { versions: true, currentVersion: true },
      orderBy: { id: "asc" },
    });
    expect(docs.map((d) => d.id)).toEqual(MANIFEST_IDS);

    for (const doc of docs) {
      expect(doc.versions).toHaveLength(1);
      const [v1] = doc.versions;
      expect(v1?.versionNo).toBe(1);
      expect(v1?.status).toBe("queued");
      expect(v1?.attempt).toBe(0);
      expect(v1?.parsedText).toBeNull();
      expect(doc.currentVersion?.id).toBe(v1?.id);
    }

    const invoice = docs.find((d) => d.id === "doc-invoice-001");
    const onDisk = readFileSync(join(fixturesDir, "documents", "invoice-001.pdf"));
    expect(Buffer.from(invoice?.currentVersion?.fileBytes ?? [])).toEqual(onDisk);
    expect(invoice?.currentVersion?.sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
  });

  it("is idempotent and never resets a version that has progressed", async () => {
    const before = await prisma.documentVersion.findMany({ orderBy: { id: "asc" } });
    const invoiceV1 = before.find((v) => v.documentId === "doc-invoice-001");
    await prisma.documentVersion.update({
      where: { id: invoiceV1?.id },
      data: { status: "extracted", parsedText: "already parsed" },
    });

    const result = await seed(prisma, fixturesDir);
    expect(result.inserted).toEqual([]);
    expect(result.skipped.sort()).toEqual(MANIFEST_IDS);

    const after = await prisma.documentVersion.findMany({ orderBy: { id: "asc" } });
    expect(after.map((v) => v.id)).toEqual(before.map((v) => v.id));
    const invoiceAfter = after.find((v) => v.id === invoiceV1?.id);
    expect(invoiceAfter?.status).toBe("extracted");
    expect(invoiceAfter?.parsedText).toBe("already parsed");
  });
});
