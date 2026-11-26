import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createPrismaClient, type PrismaClient } from "../src/index.js";
import { withDatabase } from "./global-setup.js";

export interface TestDatabase {
  prisma: PrismaClient;
  drop: () => Promise<void>;
}

/** A fresh, fully migrated database cloned from the template. One per test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject("adminUrl");
  const name = `lomi_t_${randomUUID().replaceAll("-", "")}`;
  await adminQuery(adminUrl, `CREATE DATABASE "${name}" TEMPLATE "${inject("templateDb")}"`);
  const prisma = createPrismaClient(withDatabase(adminUrl, name));
  return {
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      await adminQuery(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

async function adminQuery(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
