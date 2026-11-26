import {
  DocumentListResponseSchema,
  ErrorResponseSchema,
  UploadResponseSchema,
  ValueDtoSchema,
  VersionDetailSchema,
  type DocumentType,
  type ReviewRequest,
} from "@lomi/shared";
import type { z } from "zod";

/** Same-origin: next.config rewrites /api/* to the Fastify API. */
const BASE = "/api";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<S extends z.ZodType>(schema: S, path: string, init?: RequestInit): Promise<z.infer<S>> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    throw parsed.success
      ? new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message)
      : new ApiRequestError(res.status, "http_error", `request failed with status ${res.status}`);
  }
  return schema.parse(body);
}

export const api = {
  listDocuments: () => request(DocumentListResponseSchema, "/documents"),

  getDocument: (id: string, versionNo?: number) =>
    request(
      VersionDetailSchema,
      versionNo === undefined ? `/documents/${encodeURIComponent(id)}` : `/documents/${encodeURIComponent(id)}/versions/${versionNo}`,
    ),

  uploadDocument: (input: { type: DocumentType; title?: string; file: File }) => {
    const form = new FormData();
    form.append("type", input.type);
    if (input.title) form.append("title", input.title);
    form.append("file", input.file);
    return request(UploadResponseSchema, "/documents", { method: "POST", body: form });
  },

  uploadVersion: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request(UploadResponseSchema, `/documents/${encodeURIComponent(id)}/versions`, { method: "POST", body: form });
  },

  retry: (id: string) =>
    request(UploadResponseSchema, `/documents/${encodeURIComponent(id)}/retry`, { method: "POST" }),

  review: (valueId: string, body: ReviewRequest) =>
    request(ValueDtoSchema, `/values/${valueId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};

export const queryKeys = {
  documents: ["documents"] as const,
  document: (id: string, versionNo?: number) => ["document", id, versionNo ?? "current"] as const,
};
