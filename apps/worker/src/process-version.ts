import type { PrismaClient } from "@lomi/db";
import {
  buildExtractionPrompt,
  ExtractionResponseError,
  extractPdfText,
  PdfParseError,
  planCarryOver,
  validateExtraction,
  type ExtractedField,
} from "@lomi/extraction";
import { DocumentTypeSchema, FieldValueSchema, GapReasonSchema } from "@lomi/shared";
import { LlmError, type ExtractionLlm, type LlmResult } from "./llm.js";
import {
  claimVersion,
  commitExtraction,
  extendLease,
  fenceOutcome,
  FencedOut,
  finishRun,
  loadPreviousValues,
  markFailed,
  requeueOrFail,
  storeParsedText,
  type ClaimedVersion,
} from "./versions.js";

export interface WorkerDeps {
  prisma: PrismaClient;
  llm: ExtractionLlm;
  /** Rings the doorbell again (after a backoff). Failure is fine: the reconciler re-rings. */
  enqueue: (versionId: string, delayMs: number) => Promise<void>;
  leaseMs: number;
  heartbeatMs: number;
  /** Base for exponential backoff after a transient LLM error. */
  retryBaseMs?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export type ProcessResult = "not_claimed" | "extracted" | "failed" | "requeued" | "superseded" | "fenced_out";

class LeaseLost extends Error {
  override readonly name = "LeaseLost";
}

/**
 * One extraction attempt for one version. Safe to call any number of times,
 * concurrently, for the same version: only a successful claim does work, and
 * only the attempt that still holds the lease can commit.
 */
export async function processVersion(deps: WorkerDeps, versionId: string): Promise<ProcessResult> {
  const { prisma, llm } = deps;
  const log = deps.log ?? (() => {});

  const version = await claimVersion(prisma, versionId, deps.leaseMs);
  if (!version) return "not_claimed";
  log("claimed", { versionId, attempt: version.attempt });

  const lease = holdLease(deps, version);
  const run = await prisma.extractionRun.create({
    data: { versionId: version.id, attempt: version.attempt, model: llm.model },
  });
  let llmResult: LlmResult | null = null;

  try {
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: version.documentId },
      select: { type: true },
    });
    const type = DocumentTypeSchema.parse(document.type);

    let parsedText = version.parsedText;
    if (parsedText === null) {
      parsedText = await extractPdfText(version.fileBytes);
      if (!(await storeParsedText(prisma, version, parsedText))) throw new LeaseLost();
    }

    const prompt = buildExtractionPrompt(type, parsedText);
    await prisma.extractionRun.update({ where: { id: run.id }, data: { prompt: JSON.stringify(prompt) } });

    llmResult = await llm.extract(prompt, lease.signal);
    const fields = validateExtraction(type, parsedText, llmResult.output);

    const previous = await loadPreviousValues(prisma, version.documentId, version.versionNo);
    const decisions = planCarryOver({
      previous: previous.map((p) => ({
        id: p.id,
        field: p.field,
        value: p.value === null ? null : FieldValueSchema.parse(p.value),
        evidenceText: p.evidenceText,
        gapReason: p.gapReason === null ? null : GapReasonSchema.parse(p.gapReason),
        latestReviewId: p.latestReview?.id ?? null,
      })),
      current: fields,
      currentParsedText: parsedText,
    });

    await commitExtraction(prisma, {
      version,
      runId: run.id,
      fields,
      decisions,
      previous,
      run: {
        model: llmResult.model,
        rawResponse: llmResult.raw,
        inputTokens: llmResult.inputTokens,
        outputTokens: llmResult.outputTokens,
      },
    });
    log("extracted", { versionId, attempt: version.attempt, ...summarize(fields) });
    return "extracted";
  } catch (error) {
    return await handleFailure(deps, version, run.id, error, llmResult, lease.lost);
  } finally {
    lease.release();
  }
}

async function handleFailure(
  deps: WorkerDeps,
  version: ClaimedVersion,
  runId: string,
  error: unknown,
  llmResult: LlmResult | null,
  leaseWasLost: boolean,
): Promise<ProcessResult> {
  const { prisma } = deps;
  const log = deps.log ?? (() => {});
  const llmFields = {
    rawResponse: llmResult?.raw ?? (error instanceof LlmError ? error.raw : undefined),
    ...(llmResult && {
      model: llmResult.model,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
    }),
  };

  // Lost the lease (superseded, or another attempt took over): our result,
  // whatever it was, must not be written. Log the run and walk away.
  if (error instanceof FencedOut || error instanceof LeaseLost || leaseWasLost) {
    const outcome = await fenceOutcome(prisma, version.id);
    await finishRun(prisma, runId, { outcome, error: `result discarded: ${outcome}`, ...llmFields });
    log("discarded", { versionId: version.id, attempt: version.attempt, outcome });
    return outcome === "superseded" ? "superseded" : "fenced_out";
  }

  const message = describe(error);

  if (error instanceof LlmError && error.retryable) {
    const delayMs = (deps.retryBaseMs ?? 5_000) * 2 ** version.attempt;
    const status = await requeueOrFail(prisma, version, message, delayMs);
    await finishRun(prisma, runId, { outcome: "failed", error: message, ...llmFields });
    if (status === "queued") {
      await deps.enqueue(version.id, delayMs).catch(() => {});
      log("requeued", { versionId: version.id, attempt: version.attempt, delayMs, error: message });
      return "requeued";
    }
    log("failed", { versionId: version.id, attempt: version.attempt, error: message });
    return status === "failed" ? "failed" : await discardedOutcome(prisma, version.id);
  }

  // Parse, schema, refusal or unexpected errors: a visible, retryable failure.
  const marked = await markFailed(prisma, version, message);
  await finishRun(prisma, runId, { outcome: "failed", error: message, ...llmFields });
  log("failed", { versionId: version.id, attempt: version.attempt, error: message });
  return marked ? "failed" : await discardedOutcome(prisma, version.id);
}

async function discardedOutcome(prisma: PrismaClient, versionId: string): Promise<ProcessResult> {
  return (await fenceOutcome(prisma, versionId)) === "superseded" ? "superseded" : "fenced_out";
}

function describe(error: unknown): string {
  if (error instanceof PdfParseError || error instanceof ExtractionResponseError || error instanceof LlmError) {
    return error.message;
  }
  return `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Keeps the lease alive while the attempt runs. If an extension is refused,
 * the version was superseded or re-claimed: abort the LLM call at once.
 */
function holdLease(deps: WorkerDeps, version: ClaimedVersion) {
  const controller = new AbortController();
  let lost = false;
  const timer = setInterval(() => {
    extendLease(deps.prisma, version.id, version.attempt, deps.leaseMs)
      .then((held) => {
        if (!held && !lost) {
          lost = true;
          controller.abort(new LeaseLost());
        }
      })
      .catch(() => {
        // Postgres unreachable: keep trying; if it stays down the lease simply
        // expires and the reconciler hands the version to a fresh attempt.
      });
  }, deps.heartbeatMs);
  return {
    signal: controller.signal,
    get lost() {
      return lost;
    },
    release: () => clearInterval(timer),
  };
}

function summarize(fields: ExtractedField[]) {
  return { values: fields.filter((f) => f.gapReason === null).length, gaps: fields.filter((f) => f.gapReason).length };
}
