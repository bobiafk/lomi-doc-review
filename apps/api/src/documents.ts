import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@lomi/db";
import { normalizeValue } from "@lomi/extraction";
import {
  DocumentTypeSchema,
  type DocumentSummary,
  type DocumentType,
  type ReviewRequest,
  type ValueDto,
  type VersionDetail,
} from "@lomi/shared";
import { fieldTypeOf, latestReviewFirst, progressOf, sortByFieldOrder, toValueDto, toVersionSummary, valueInclude } from "./dto.js";
import { ApiError } from "./errors.js";

export interface UploadedFile {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Commit first: the version row exists (queued) before anyone rings the queue. */
export async function createDocument(
  prisma: PrismaClient,
  input: { type: DocumentType; title?: string | undefined; file: UploadedFile },
): Promise<{ documentId: string; versionId: string }> {
  const documentId = `doc-${randomUUID()}`;
  return prisma.$transaction(async (tx) => {
    await tx.document.create({
      data: { id: documentId, type: input.type, title: input.title ?? input.file.fileName.replace(/\.pdf$/i, "") },
    });
    const version = await tx.documentVersion.create({
      data: {
        documentId,
        versionNo: 1,
        fileName: input.file.fileName,
        fileBytes: input.file.bytes,
        sha256: sha256(input.file.bytes),
      },
    });
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: version.id } });
    return { documentId, versionId: version.id };
  });
}

/**
 * New version of an existing document. Supersede policy: the new version
 * becomes current; any older version still queued or extracting is marked
 * `superseded` (its worker's fenced commit will then be refused). Uploads to
 * the same document are serialized by a row lock. Re-uploading the file that
 * is already current is a no-op.
 */
export async function addVersion(
  prisma: PrismaClient,
  documentId: string,
  file: UploadedFile,
): Promise<{ versionId: string; duplicate: boolean }> {
  const hash = sha256(file.bytes);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ current_version_id: string | null }[]>`
      SELECT current_version_id FROM documents WHERE id = ${documentId} FOR UPDATE`;
    const doc = locked[0];
    if (!doc) throw new ApiError(404, "document_not_found", `document ${documentId} not found`);

    const current = doc.current_version_id
      ? await tx.documentVersion.findUnique({ where: { id: doc.current_version_id }, select: { id: true, sha256: true } })
      : null;
    if (current && current.sha256 === hash) return { versionId: current.id, duplicate: true };

    await tx.documentVersion.updateMany({
      where: { documentId, status: { in: ["queued", "extracting"] } },
      data: { status: "superseded" },
    });
    const last = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNo: true } });
    const version = await tx.documentVersion.create({
      data: {
        documentId,
        versionNo: (last._max.versionNo ?? 0) + 1,
        fileName: file.fileName,
        fileBytes: file.bytes,
        sha256: hash,
      },
    });
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: version.id } });
    return { versionId: version.id, duplicate: false };
  });
}

/** Manual retry: failed -> queued with a fresh budget of automatic attempts. */
export async function retryCurrentVersion(prisma: PrismaClient, documentId: string): Promise<string> {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { currentVersionId: true } });
  if (!doc?.currentVersionId) throw new ApiError(404, "document_not_found", `document ${documentId} not found`);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE document_versions
    SET status = 'queued', attempts_left = 3, available_at = now(), last_error = NULL, updated_at = now()
    WHERE id = ${doc.currentVersionId}::uuid AND status = 'failed'
    RETURNING id`;
  if (!rows[0]) throw new ApiError(409, "not_failed", "only a failed current version can be retried");
  return rows[0].id;
}

/** Appends a review. The extracted value and its evidence are never modified. */
export async function reviewValue(prisma: PrismaClient, valueId: string, request: ReviewRequest): Promise<ValueDto> {
  const value = await prisma.extractedValue.findUnique({
    where: { id: valueId },
    select: {
      field: true,
      version: { select: { id: true, status: true, document: { select: { type: true, currentVersionId: true } } } },
    },
  });
  if (!value) throw new ApiError(404, "value_not_found", `value ${valueId} not found`);
  if (value.version.document.currentVersionId !== value.version.id) {
    throw new ApiError(409, "not_current_version", "only values of the current version can be reviewed");
  }
  const type = DocumentTypeSchema.parse(value.version.document.type);

  if (request.action === "approve") {
    await prisma.review.create({ data: { valueId, action: "approve", note: request.note ?? null } });
  } else {
    const normalized = normalizeValue(fieldTypeOf(type, value.field), request.value, request.currency);
    if (!normalized.ok) throw new ApiError(422, "invalid_value", normalized.error);
    await prisma.review.create({
      data: { valueId, action: "correct", correctedValue: normalized.value, note: request.note ?? null },
    });
  }

  const row = await prisma.extractedValue.findUniqueOrThrow({ where: { id: valueId }, include: valueInclude });
  return toValueDto(type, row);
}

const summarySelect = {
  id: true,
  type: true,
  title: true,
  currentVersion: {
    select: {
      id: true,
      versionNo: true,
      status: true,
      fileName: true,
      createdAt: true,
      values: {
        select: {
          gapReason: true,
          reviews: { orderBy: latestReviewFirst, take: 1, select: { action: true, carriedFromReviewId: true } },
        },
      },
    },
  },
  _count: { select: { versions: true } },
} as const;

type SummaryRow = NonNullable<Awaited<ReturnType<typeof findSummaries>>[number]>;

function findSummaries(prisma: PrismaClient, where: { id?: string }) {
  return prisma.document.findMany({ where, select: summarySelect, orderBy: { createdAt: "asc" } });
}

function toSummary(row: SummaryRow): DocumentSummary {
  const current = row.currentVersion;
  if (!current) throw new Error(`document ${row.id} has no current version`);
  return {
    id: row.id,
    type: DocumentTypeSchema.parse(row.type),
    title: row.title,
    status: current.status,
    currentVersion: toVersionSummary(current),
    versionCount: row._count.versions,
    progress: progressOf(current.values),
  };
}

export async function listDocuments(prisma: PrismaClient): Promise<DocumentSummary[]> {
  return (await findSummaries(prisma, {})).map(toSummary);
}

export async function getDocumentSummary(prisma: PrismaClient, documentId: string): Promise<DocumentSummary> {
  const [row] = await findSummaries(prisma, { id: documentId });
  if (!row) throw new ApiError(404, "document_not_found", `document ${documentId} not found`);
  return toSummary(row);
}

/** A version with its values, as of now. Defaults to the current version. */
export async function getVersionDetail(
  prisma: PrismaClient,
  documentId: string,
  versionNo?: number,
): Promise<VersionDetail> {
  const summary = await getDocumentSummary(prisma, documentId);
  const versions = await prisma.documentVersion.findMany({
    where: { documentId },
    orderBy: { versionNo: "asc" },
    select: { id: true, versionNo: true, status: true, fileName: true, createdAt: true },
  });
  const wanted = versionNo ?? summary.currentVersion.versionNo;
  const target = versions.find((v) => v.versionNo === wanted);
  if (!target) throw new ApiError(404, "version_not_found", `document ${documentId} has no version ${wanted}`);

  const version = await prisma.documentVersion.findUniqueOrThrow({
    where: { id: target.id },
    select: {
      attempt: true,
      attemptsLeft: true,
      lastError: true,
      parsedText: true,
      values: { include: valueInclude },
    },
  });
  const values = sortByFieldOrder(summary.type, version.values);

  return {
    document: { ...summary, versions: versions.map(toVersionSummary) },
    version: {
      ...toVersionSummary(target),
      isCurrent: target.id === summary.currentVersion.id,
      attempt: version.attempt,
      attemptsLeft: version.attemptsLeft,
      lastError: version.lastError,
      parsedText: version.parsedText,
    },
    values: values.map((v) => toValueDto(summary.type, v)),
    progress: progressOf(values),
  };
}
