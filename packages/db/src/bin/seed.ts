import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../client.js";
import { seed } from "../seed.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");

// dist/bin/seed.js -> repo root /fixtures, unless overridden (Docker sets it).
const fixturesDir =
  process.env["FIXTURES_DIR"] ?? fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

const prisma = createPrismaClient(databaseUrl);
try {
  const { inserted, skipped } = await seed(prisma, fixturesDir);
  console.log(`seed: inserted v1 for [${inserted.join(", ")}]; already present [${skipped.join(", ")}]`);
} finally {
  await prisma.$disconnect();
}
