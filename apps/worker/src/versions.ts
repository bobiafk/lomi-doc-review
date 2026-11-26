import { Prisma, type PrismaClient, type RunOutcome } from "@lomi/db";
import type { CarryOverDecision, ExtractedField } from "@lomi/extraction";

/**
 * Every state change of a version goes through here, and every write after
 * the claim is fenced on (id, attempt, status = 'extracting'): a worker that
 * lost its lease, or whose version was superseded, can no longer change
 * anything. Times come from Postgres' clock, never the worker's.
 */

export interface ClaimedVersion {
  id: string;
  documentId: string;
  versionNo: number;
  attempt: number;
  attemptsLeft: number;
  parsedText: string | null;
  fileBytes: Uint8Array;
}

/**
 * Atomic claim: one conditional UPDATE. Zero rows means someone else owns the
 * version, it is already done, it is backing off, or it is out of attempts.
 */
export async function claimVersion(
  prisma: PrismaClient,
  versionId: string,
  leaseMs: number,
): Promise<ClaimedVersion | null> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      document_id: string;
      version_no: number;
      attempt: number;
      attempts_left: number;
      parsed_text: string | null;
      file_bytes: Uint8Array;
    }[]
  >`
    UPDATE document_versions
    SET status = 'extracting',
        attempt = attempt + 1,
        attempts_left = attempts_left - 1,
        lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
        updated_at = now()
    WHERE id = ${versionId}::uuid
      AND attempts_left > 0
      AND available_at <= now()
      AND (status = 'queued' OR (status = 'extracting' AND lease_expires_at < now()))
    RETURNING id, document_id, version_no, attempt, attempts_left, parsed_text, file_bytes`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    versionNo: row.version_no,
    attempt: row.attempt,
    attemptsLeft: row.attempts_left,
    parsedText: row.parsed_text,
    fileBytes: row.file_bytes,
  };
}

/** Extends the lease. False means the lease is gone (superseded or re-claimed). */
export async function extendLease(
  prisma: PrismaClient,
  versionId: string,
  attempt: number,
  leaseMs: number,
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE document_versions
    SET lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = ${versionId}::uuid AND attempt = ${attempt} AND status = 'extracting'`;
  return updated === 1;
}

export async function storeParsedText(
  prisma: PrismaClient,
  version: ClaimedVersion,
  parsedText: string,
): Promise<boolean> {
  const { count } = await prisma.documentVersion.updateMany({
    where: { id: version.id, attempt: version.attempt, status: "extracting" },
    data: { parsedText },
  });
  return count === 1;
}

export async function markFailed(prisma: PrismaClient, version: ClaimedVersion, error: string): Promise<boolean> {
  const { count } = await prisma.documentVersion.updateMany({
    where: { id: version.id, attempt: version.attempt, status: "extracting" },
    data: { status: "failed", lastError: error, leaseExpiresAt: null },
  });
  return count === 1;
}

/**
 * After a transient error: back to `queued` with a backoff, or `failed` if no
 * automatic attempts are left. Returns the resulting status, or null if the
 * lease was already lost.
 */
export async function requeueOrFail(
  prisma: PrismaClient,
  version: ClaimedVersion,
  error: string,
  delayMs: number,
): Promise<"queued" | "failed" | null> {
  const rows = await prisma.$queryRaw<{ status: "queued" | "failed" }[]>`
    UPDATE document_versions
    SET status = CASE WHEN attempts_left > 0 THEN 'queued'::"VersionStatus" ELSE 'failed'::"VersionStatus" END,
        last_error = ${error},
        lease_expires_at = NULL,
        available_at = now() + make_interval(secs => ${delayMs / 1000}),
        updated_at = now()
    WHERE id = ${version.id}::uuid AND attempt = ${version.attempt} AND status = 'extracting'
    RETURNING status::text AS status`;
  return rows[0]?.status ?? null;
}

/** Why a fenced write was refused: the version was superseded, or another attempt owns it. */
export async function fenceOutcome(prisma: PrismaClient, versionId: string): Promise<RunOutcome> {
  const version = await prisma.documentVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { status: true },
  });
  return version.status === "superseded" ? "superseded" : "fenced_out";
}

/** A value of the latest earlier extracted version, with its current review. */
export interface PreviousValueRow {
  id: string;
  field: string;
  value: Prisma.JsonValue | null;
  evidenceText: string | null;
  gapReason: string | null;
  latestReview: {
    id: string;
    action: "approve" | "correct";
    correctedValue: Prisma.JsonValue | null;
    note: string | null;
  } | null;
}

/** Values of the latest version of the document, older than `versionNo`, that reached `extracted`. */
export async function loadPreviousValues(
  prisma: PrismaClient,
  documentId: string,
  versionNo: number,
): Promise<PreviousValueRow[]> {
  const previous = await prisma.documentVersion.findFirst({
    where: { documentId, status: "extracted", versionNo: { lt: versionNo } },
    orderBy: { versionNo: "desc" },
    select: {
      values: {
        select: {
          id: true,
          field: true,
          value: true,
          evidenceText: true,
          gapReason: true,
          reviews: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { id: true, action: true, correctedValue: true, note: true },
          },
        },
      },
    },
  });
  return (previous?.values ?? []).map(({ reviews, ...value }) => ({ ...value, latestReview: reviews[0] ?? null }));
}

export class FencedOut extends Error {
  override readonly name = "FencedOut";
}

/**
 * The fenced commit: status, values, carried reviews and the run outcome in ONE
 * transaction, and only if this attempt still owns the version. The status
 * UPDATE goes first so it takes the row lock; a concurrent supersede waits
 * for it or wins outright. unique(version_id, field) makes duplicates
 * impossible even if the fence were bypassed.
 */
export async function commitExtraction(
  prisma: PrismaClient,
  input: {
    version: ClaimedVersion;
    runId: string;
    fields: ExtractedField[];
    decisions: CarryOverDecision[];
    previous: PreviousValueRow[];
    run: { model: string; rawResponse: unknown; inputTokens: number | null; outputTokens: number | null };
  },
): Promise<void> {
  const { version, runId, fields, decisions, previous, run } = input;
  const decisionByField = new Map(decisions.map((d) => [d.field, d]));
  const reviewById = new Map(
    previous.flatMap((p) => (p.latestReview ? [[p.latestReview.id, p.latestReview] as const] : [])),
  );

  await prisma.$transaction(async (tx) => {
    const fenced = await tx.$executeRaw`
      UPDATE document_versions
      SET status = 'extracted', lease_expires_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${version.id}::uuid AND attempt = ${version.attempt} AND status = 'extracting'`;
    if (fenced !== 1) throw new FencedOut();

    const created = await tx.extractedValue.createManyAndReturn({
      data: fields.map((f) => ({
        versionId: version.id,
        runId,
        field: f.field,
        value: f.value === null ? Prisma.DbNull : f.value,
        evidenceText: f.evidenceText,
        evidenceStart: f.evidenceStart,
        evidenceEnd: f.evidenceEnd,
        gapReason: f.gapReason,
        gapDetail: f.gapDetail,
        previousValueId: decisionByField.get(f.field)?.previousValueId ?? null,
      })),
      select: { id: true, field: true },
    });

    const carried = created.flatMap(({ id, field }) => {
      const reviewId = decisionByField.get(field)?.carryReviewId;
      const review = reviewId ? reviewById.get(reviewId) : undefined;
      if (!review) return [];
      return [
        {
          valueId: id,
          action: review.action,
          correctedValue: review.correctedValue === null ? Prisma.DbNull : review.correctedValue,
          note: review.note,
          carriedFromReviewId: review.id,
        },
      ];
    });
    if (carried.length > 0) await tx.review.createMany({ data: carried });

    await tx.extractionRun.update({
      where: { id: runId },
      data: {
        outcome: "succeeded",
        model: run.model,
        rawResponse: toJson(run.rawResponse),
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        finishedAt: new Date(),
      },
    });
  });
}

export async function finishRun(
  prisma: PrismaClient,
  runId: string,
  data: {
    outcome: RunOutcome;
    error?: string | null;
    model?: string;
    rawResponse?: unknown;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): Promise<void> {
  await prisma.extractionRun.update({
    where: { id: runId },
    data: {
      outcome: data.outcome,
      error: data.error ?? null,
      ...(data.model !== undefined && { model: data.model }),
      ...(data.rawResponse !== undefined && { rawResponse: toJson(data.rawResponse) }),
      ...(data.inputTokens !== undefined && { inputTokens: data.inputTokens }),
      ...(data.outputTokens !== undefined && { outputTokens: data.outputTokens }),
      finishedAt: new Date(),
    },
  });
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
