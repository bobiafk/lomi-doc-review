import type { ErrorResponse } from "@lomi/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";

/** An error the client caused or should see. Rendered as { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "invalid_request", `invalid ${what}`, z.flattenError(result.error));
  }
  return result.data;
}

function body(code: string, message: string, details?: unknown): ErrorResponse {
  return { error: { code, message, ...(details !== undefined && { details }) } };
}

/** Every error leaves the API in the same JSON shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(body("not_found", `no route for ${request.method} ${request.url}`));
  });

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send(body(error.code, error.message, error.details));
    }
    // Fastify / plugin errors (body too large, malformed multipart, bad JSON...).
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send(body(error.code?.toLowerCase() ?? "bad_request", error.message));
    }
    request.log.error(error);
    return reply.code(500).send(body("internal", "something went wrong"));
  });
}
