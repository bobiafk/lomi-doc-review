import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection string for the server; used to create per-file databases. */
    adminUrl: string;
    /** Name of a database with all migrations applied, used as a CREATE DATABASE template. */
    templateDb: string;
  }
}

/**
 * Applies the real migrations once (`prisma migrate deploy`) to a template
 * database; each test file then clones it, so files are isolated from each
 * other. Needs Postgres at DATABASE_URL (`docker compose up -d postgres`
 * locally, a service container in CI).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const adminUrl = process.env["DATABASE_URL"];
  if (!adminUrl) {
    throw new Error("DATABASE_URL is not set. Start Postgres with `docker compose up -d postgres`.");
  }

  const templateDb = `lomi_tpl_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${templateDb}"`);

  execSync("prisma migrate deploy", {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: withDatabase(adminUrl, templateDb) },
    stdio: "pipe",
  });

  project.provide("adminUrl", adminUrl);
  project.provide("templateDb", templateDb);

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${templateDb}" WITH (FORCE)`);
    await admin.end();
  };
}

export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
