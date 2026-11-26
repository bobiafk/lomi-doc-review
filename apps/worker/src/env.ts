import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** `canned` is a dev-only stand-in that answers for the fixture documents (see canned-llm.ts). */
  EXTRACTION_LLM: z.enum(["anthropic", "canned"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LEASE_MS: z.coerce.number().int().positive().default(60_000),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  RECONCILE_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  if (env.EXTRACTION_LLM === "anthropic" && env.ANTHROPIC_API_KEY === "") {
    throw new Error("ANTHROPIC_API_KEY is required (or set EXTRACTION_LLM=canned for the dev-only stand-in)");
  }
  return env;
}
