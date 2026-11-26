import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required to run extractions"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LEASE_MS: z.coerce.number().int().positive().default(60_000),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  RECONCILE_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
