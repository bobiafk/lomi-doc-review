import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma, seed, type PrismaClient } from "@lomi/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const INVOICE = "doc-invoice-001";

export function fixturePdf(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}documents/${name}`));
}

export function testApp(prisma: PrismaClient, enqueue: (versionId: string) => Promise<void> = async () => {}) {
  const enqueued: string[] = [];
  const app = buildApp({
    prisma,
    enqueue: async (id) => {
      enqueued.push(id);
      await enqueue(id);
    },
  });
  return { app, enqueued };
}

export async function seedFixtures(prisma: PrismaClient): Promise<void> {
  await seed(prisma, FIXTURES);
}

/** POSTs a multipart upload. */
export function upload(
  app: FastifyInstance,
  url: string,
  file: { name: string; bytes: Uint8Array } | null,
  fields: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append("file", new Blob([file.bytes], { type: "application/pdf" }), file.name);
  return app.inject({ method: "POST", url, payload: form });
}

export interface FakeValue {
  field: string;
  value?: Prisma.InputJsonValue;
  evidence?: string;
  gapReason?: string;
  gapDetail?: string;
  previousValueId?: string;
}

/**
 * Puts a version in the state the worker leaves it in after a successful
 * extraction (the worker itself is tested in apps/worker).
 */
export async function markExtracted(prisma: PrismaClient, versionId: string, values: FakeValue[]) {
  const parsedText = values.map((v) => v.evidence ?? "").join("\n");
  await prisma.documentVersion.update({
    where: { id: versionId },
    data: { status: "extracted", attempt: 1, attemptsLeft: 2, parsedText },
  });
  const run = await prisma.extractionRun.create({ data: { versionId, attempt: 1, model: "fake", outcome: "succeeded" } });
  let offset = 0;
  const created: Record<string, string> = {};
  for (const v of values) {
    const start = offset;
    offset += (v.evidence ?? "").length + 1;
    const row = await prisma.extractedValue.create({
      data: {
        versionId,
        runId: run.id,
        field: v.field,
        value: v.gapReason || v.value === undefined ? Prisma.DbNull : v.value,
        evidenceText: v.gapReason ? null : (v.evidence ?? null),
        evidenceStart: v.gapReason ? null : start,
        evidenceEnd: v.gapReason ? null : start + (v.evidence ?? "").length,
        gapReason: v.gapReason ?? null,
        gapDetail: v.gapDetail ?? null,
        previousValueId: v.previousValueId ?? null,
      },
    });
    created[v.field] = row.id;
  }
  return created;
}

export const invoiceV1Values: FakeValue[] = [
  { field: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847" },
  { field: "issue_date", value: "2025-09-14", evidence: "Issue Date: 2025-09-14" },
  { field: "due_date", value: "2025-10-14", evidence: "Due Date: 2025-10-14" },
  { field: "vendor_name", value: "Meridian Office Supplies LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC" },
  { field: "total_amount", value: { cents: 523029, currency: "USD" }, evidence: "Total Due: $5,230.29" },
];
