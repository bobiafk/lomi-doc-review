import multipart from "@fastify/multipart";
import type { PrismaClient } from "@lomi/db";
import {
  DocumentParamsSchema,
  ReviewRequestSchema,
  UploadDocumentFieldsSchema,
  ValueParamsSchema,
  VersionParamsSchema,
  type DocumentListResponse,
  type UploadResponse,
} from "@lomi/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  addVersion,
  createDocument,
  getDocumentSummary,
  getVersionDetail,
  listDocuments,
  retryCurrentVersion,
  reviewValue,
  type UploadedFile,
} from "./documents.js";
import { toVersionSummary } from "./dto.js";
import { ApiError, parseInput, registerErrorHandling } from "./errors.js";

export interface AppDeps {
  prisma: PrismaClient;
  /** Rings the extraction doorbell. May fail: the version is already committed and the reconciler catches up. */
  enqueue: (versionId: string) => Promise<void>;
  logger?: boolean;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The HTTP API. It never talks to the LLM: uploads commit a `queued` version
 * and ring the queue, so a response never waits for extraction.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { prisma } = deps;
  const app = Fastify({ logger: deps.logger ?? false });
  registerErrorHandling(app);
  void app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 }, throwFileSizeLimit: true });

  async function ring(versionId: string, request: FastifyRequest): Promise<void> {
    try {
      await deps.enqueue(versionId);
    } catch (error) {
      // Postgres already has the queued version; the worker's reconciler will
      // enqueue it within one interval. The upload still succeeded.
      request.log.warn({ versionId, error: (error as Error).message }, "enqueue failed; reconciler will pick it up");
    }
  }

  async function uploadResponse(documentId: string, versionId: string, duplicate: boolean): Promise<UploadResponse> {
    const document = await getDocumentSummary(prisma, documentId);
    const version = await prisma.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { id: true, versionNo: true, status: true, fileName: true, createdAt: true },
    });
    return { document, version: toVersionSummary(version), duplicate };
  }

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  });

  app.post("/documents", async (request, reply) => {
    const { fields, file } = await readUpload(request);
    const input = parseInput(UploadDocumentFieldsSchema, fields, "upload fields");
    const { documentId, versionId } = await createDocument(prisma, { ...input, file });
    await ring(versionId, request);
    return reply.code(202).send(await uploadResponse(documentId, versionId, false));
  });

  app.post("/documents/:id/versions", async (request, reply) => {
    const { id } = parseInput(DocumentParamsSchema, request.params, "path");
    const { file } = await readUpload(request);
    const { versionId, duplicate } = await addVersion(prisma, id, file);
    if (!duplicate) await ring(versionId, request);
    return reply.code(duplicate ? 200 : 202).send(await uploadResponse(id, versionId, duplicate));
  });

  app.get("/documents", async (): Promise<DocumentListResponse> => ({ documents: await listDocuments(prisma) }));

  app.get("/documents/:id", async (request) => {
    const { id } = parseInput(DocumentParamsSchema, request.params, "path");
    return getVersionDetail(prisma, id);
  });

  app.get("/documents/:id/versions/:versionNo", async (request) => {
    const { id, versionNo } = parseInput(VersionParamsSchema, request.params, "path");
    return getVersionDetail(prisma, id, versionNo);
  });

  app.get("/documents/:id/progress", async (request) => {
    const { id } = parseInput(DocumentParamsSchema, request.params, "path");
    return (await getDocumentSummary(prisma, id)).progress;
  });

  app.post("/documents/:id/retry", async (request, reply) => {
    const { id } = parseInput(DocumentParamsSchema, request.params, "path");
    const versionId = await retryCurrentVersion(prisma, id);
    await ring(versionId, request);
    return reply.code(202).send(await uploadResponse(id, versionId, false));
  });

  app.post("/values/:id/review", async (request, reply) => {
    const { id } = parseInput(ValueParamsSchema, request.params, "path");
    const body = parseInput(ReviewRequestSchema, request.body, "review");
    return reply.code(201).send(await reviewValue(prisma, id, body));
  });

  return app;
}

/** Reads a multipart upload: exactly one PDF file plus plain fields. */
async function readUpload(request: FastifyRequest): Promise<{ fields: Record<string, string>; file: UploadedFile }> {
  if (!request.isMultipart()) throw new ApiError(415, "unsupported_media_type", "expected multipart/form-data");
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      file = { fileName: part.filename || "upload.pdf", bytes: new Uint8Array(await part.toBuffer()) };
    } else if (typeof part.value === "string") {
      fields[part.fieldname] = part.value;
    }
  }
  if (!file) throw new ApiError(400, "file_required", 'a PDF file is required in the "file" field');
  if (Buffer.from(file.bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new ApiError(415, "not_a_pdf", "the uploaded file is not a PDF");
  }
  return { fields, file };
}
