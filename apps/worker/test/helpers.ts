import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { seed, type PrismaClient } from "@lomi/db";
import type { ExtractionPrompt } from "@lomi/extraction";
import type { ExtractionLlm, LlmResult } from "../src/llm.js";
import type { WorkerDeps } from "../src/process-version.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
export const INVOICE = "doc-invoice-001";

/** Seeds the three manifest documents, v1 queued, exactly like `docker compose up`. */
export async function seedFixtures(prisma: PrismaClient): Promise<void> {
  await seed(prisma, FIXTURES);
}

export async function versionId(prisma: PrismaClient, documentId: string, versionNo = 1): Promise<string> {
  const v = await prisma.documentVersion.findUniqueOrThrow({
    where: { documentId_versionNo: { documentId, versionNo } },
    select: { id: true },
  });
  return v.id;
}

/** What the API will do on upload: new current version, queued; in-flight ones superseded. */
export async function uploadVersion(
  prisma: PrismaClient,
  documentId: string,
  file: string | Uint8Array,
): Promise<string> {
  const bytes = typeof file === "string" ? await readFile(`${FIXTURES}documents/${file}`) : Buffer.from(file);
  return prisma.$transaction(async (tx) => {
    const last = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { versionNo: "desc" } });
    await tx.documentVersion.updateMany({
      where: { documentId, status: { in: ["queued", "extracting"] } },
      data: { status: "superseded" },
    });
    const created = await tx.documentVersion.create({
      data: {
        documentId,
        versionNo: (last?.versionNo ?? 0) + 1,
        fileName: typeof file === "string" ? file : "upload.pdf",
        fileBytes: bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: created.id } });
    return created.id;
  });
}

type Handler = (prompt: ExtractionPrompt, signal: AbortSignal) => Promise<unknown> | unknown;

/** Test double for the LLM: returns whatever `handler` produces as the model's JSON output. */
export class FakeLlm implements ExtractionLlm {
  readonly model = "fake-model";
  calls = 0;
  constructor(private readonly handler: Handler) {}

  async extract(prompt: ExtractionPrompt, signal: AbortSignal): Promise<LlmResult> {
    this.calls++;
    const output = await this.handler(prompt, signal);
    return { model: "fake-model-answered", output, raw: { fake: true, output }, inputTokens: 100, outputTokens: 50 };
  }
}

/** Resolves when `release()` is called, or rejects when the signal aborts. */
export function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return {
    release,
    /** Resolves once the LLM call has started. */
    reached,
    wait(signal: AbortSignal): Promise<void> {
      entered();
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void opened.then(resolve);
      });
    },
  };
}

export function deps(prisma: PrismaClient, llm: ExtractionLlm, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    prisma,
    llm,
    enqueue: async () => {},
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    retryBaseMs: 0,
    ...overrides,
  };
}

const found = (value: string, evidence: string, currency: string | null = null) => ({
  found: true,
  value,
  currency,
  evidence,
  reason: null,
});

export function invoiceV1Output() {
  return {
    fields: {
      invoice_number: found("INV-2025-0847", "Invoice Number: INV-2025-0847"),
      issue_date: found("2025-09-14", "Issue Date: 2025-09-14"),
      due_date: found("2025-10-14", "Due Date: 2025-10-14"),
      vendor_name: found("Meridian Office Supplies LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
      total_amount: found("5230.29", "Total Due: $5,230.29", "USD"),
    },
  };
}

export function invoiceV2Output() {
  const v1 = invoiceV1Output();
  return {
    fields: {
      ...v1.fields,
      due_date: found("2025-11-13", "Due Date: 2025-11-13"),
      total_amount: found("6126.45", "Total Due: $6,126.45", "USD"),
    },
  };
}
