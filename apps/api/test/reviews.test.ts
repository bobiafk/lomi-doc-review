import type { PrismaClient } from "@lomi/db";
import { createTestDatabase, type TestDatabase } from "@lomi/db/testing";
import { ErrorResponseSchema, ValueDtoSchema, VersionDetailSchema } from "@lomi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixturePdf, INVOICE, invoiceV1Values, markExtracted, seedFixtures, testApp, upload } from "./helpers.js";

let db: TestDatabase;
let prisma: PrismaClient;
let ids: Record<string, string>;

beforeEach(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  await seedFixtures(prisma);
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: INVOICE } });
  ids = await markExtracted(prisma, doc.currentVersionId!, invoiceV1Values);
});
afterEach(() => db.drop());

function review(valueId: string, body: unknown) {
  return testApp(prisma).app.inject({ method: "POST", url: `/values/${valueId}/review`, payload: body as object });
}

describe("POST /values/:id/review", () => {
  it("approve: state becomes approved, effective value is the extracted one", async () => {
    const res = await review(ids["invoice_number"]!, { action: "approve" });
    expect(res.statusCode).toBe(201);
    expect(ValueDtoSchema.parse(res.json())).toMatchObject({
      reviewState: "approved",
      extractedValue: "INV-2025-0847",
      effectiveValue: "INV-2025-0847",
      review: { action: "approve", correctedValue: null, carriedFrom: null },
    });
  });

  it("correct: the correction sits beside the value, normalized for the field type", async () => {
    const res = await review(ids["total_amount"]!, { action: "correct", value: "$5,320.29", note: "typo on PDF" });
    expect(res.statusCode).toBe(201);
    const value = ValueDtoSchema.parse(res.json());
    expect(value).toMatchObject({
      reviewState: "corrected",
      extractedValue: { cents: 523029, currency: "USD" },
      effectiveValue: { cents: 532029, currency: "USD" },
      review: { action: "correct", note: "typo on PDF" },
    });
    // The extracted value and its evidence are untouched in the database.
    const row = await prisma.extractedValue.findUniqueOrThrow({ where: { id: ids["total_amount"]! } });
    expect(row.value).toEqual({ cents: 523029, currency: "USD" });
    expect(row.evidenceText).toBe("Total Due: $5,230.29");
  });

  it("reviews are append-only; the latest one decides the state", async () => {
    await review(ids["due_date"]!, { action: "correct", value: "2025-10-15" });
    const res = await review(ids["due_date"]!, { action: "approve" });
    expect(ValueDtoSchema.parse(res.json())).toMatchObject({ reviewState: "approved", effectiveValue: "2025-10-14" });
    expect(await prisma.review.count({ where: { valueId: ids["due_date"]! } })).toBe(2);
  });

  it("a gap can be approved (confirmed absent) or corrected (value supplied)", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: "doc-report-001" } });
    const gapIds = await markExtracted(prisma, doc.currentVersionId!, [
      { field: "median_household_income", gapReason: "not_found", gapDetail: "not in the excerpt" },
      { field: "vacancy_rate", gapReason: "evidence_not_found" },
    ]);
    const approved = ValueDtoSchema.parse((await review(gapIds["median_household_income"]!, { action: "approve" })).json());
    expect(approved).toMatchObject({ reviewState: "approved", effectiveValue: null, gap: { reason: "not_found" } });
    const corrected = ValueDtoSchema.parse((await review(gapIds["vacancy_rate"]!, { action: "correct", value: "4.2%" })).json());
    expect(corrected).toMatchObject({ reviewState: "corrected", extractedValue: null, effectiveValue: 4.2 });
  });

  it.each([
    [{ action: "correct", value: "next tuesday" }, "issue_date", 422, "invalid_value"],
    [{ action: "correct" }, "issue_date", 400, "invalid_request"],
    [{ action: "maybe" }, "issue_date", 400, "invalid_request"],
    [{ action: "correct", value: "   " }, "vendor_name", 400, "invalid_request"],
  ])("rejects %j", async (body, field, status, code) => {
    const res = await review(ids[field]!, body);
    expect(res.statusCode).toBe(status);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe(code);
  });

  it("404s an unknown value and 400s a malformed id", async () => {
    expect((await review("01900000-0000-7000-8000-000000000000", { action: "approve" })).statusCode).toBe(404);
    expect((await review("not-a-uuid", { action: "approve" })).statusCode).toBe(400);
  });

  it("refuses to review values of a version that is no longer current", async () => {
    const { app } = testApp(prisma);
    await upload(app, `/documents/${INVOICE}/versions`, { name: "v2.pdf", bytes: fixturePdf("invoice-001.v2.pdf") });
    const res = await review(ids["invoice_number"]!, { action: "approve" });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe("not_current_version");
  });
});

describe("after re-extraction", () => {
  it("shows carried-over values apart from pending ones, with the previous value and review beside changed ones", async () => {
    await review(ids["invoice_number"]!, { action: "approve" });
    await review(ids["total_amount"]!, { action: "approve", note: "matches PO" });

    // What the worker writes for v2: new values linked to v1's, with the unchanged review copied.
    const { app } = testApp(prisma);
    const v2Id = (await upload(app, `/documents/${INVOICE}/versions`, { name: "v2.pdf", bytes: fixturePdf("invoice-001.v2.pdf") })).json()
      .version.id as string;
    const v2Ids = await markExtracted(prisma, v2Id, [
      { ...invoiceV1Values[0]!, previousValueId: ids["invoice_number"]! },
      { field: "total_amount", value: { cents: 612645, currency: "USD" }, evidence: "Total Due: $6,126.45", previousValueId: ids["total_amount"]! },
    ]);
    const v1Review = await prisma.review.findFirstOrThrow({ where: { valueId: ids["invoice_number"]! } });
    await prisma.review.create({
      data: { valueId: v2Ids["invoice_number"]!, action: "approve", carriedFromReviewId: v1Review.id },
    });

    const detail = VersionDetailSchema.parse((await app.inject({ method: "GET", url: `/documents/${INVOICE}` })).json());
    const byField = Object.fromEntries(detail.values.map((v) => [v.field, v]));

    expect(byField["invoice_number"]).toMatchObject({
      reviewState: "carried_over",
      review: { carriedFrom: { reviewId: v1Review.id, versionNo: 1 } },
    });
    expect(byField["total_amount"]).toMatchObject({
      reviewState: "pending",
      extractedValue: { cents: 612645, currency: "USD" },
      previous: {
        versionNo: 1,
        value: { cents: 523029, currency: "USD" },
        review: { action: "approve", note: "matches PO" },
      },
    });
    expect(detail.progress).toMatchObject({ total: 2, pending: 1, carriedOver: 1 });

    // Approving a carried value again makes it plainly approved.
    const again = ValueDtoSchema.parse((await review(v2Ids["invoice_number"]!, { action: "approve" })).json());
    expect(again.reviewState).toBe("approved");
  });
});
