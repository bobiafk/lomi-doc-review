import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DocumentTypeSchema } from "@lomi/shared";
import { z } from "zod";
import type { PrismaClient } from "./generated/prisma/client.js";

export const ManifestSchema = z.array(
  z.object({
    id: z.string().min(1),
    type: DocumentTypeSchema,
    title: z.string().min(1),
    versions: z
      .array(z.object({ version: z.number().int().positive(), file: z.string().min(1) }))
      .min(1),
  }),
);
export type Manifest = z.infer<typeof ManifestSchema>;

export interface SeedResult {
  /** Manifest ids whose version 1 was inserted by this run. */
  inserted: string[];
  /** Manifest ids that already had a version 1 and were left untouched. */
  skipped: string[];
}

/**
 * Seeds version 1 of every manifest document as `queued`, so the worker's
 * reconciler picks them up. Idempotent: a document that already has a version 1
 * is left exactly as it is (its status, values and reviews are never reset).
 * Later versions in the manifest are deliberately ignored; they exist to be
 * uploaded through the API.
 */
export async function seed(prisma: PrismaClient, fixturesDir: string): Promise<SeedResult> {
  const manifest = ManifestSchema.parse(
    JSON.parse(await readFile(join(fixturesDir, "documents.json"), "utf8")),
  );
  const result: SeedResult = { inserted: [], skipped: [] };

  for (const doc of manifest) {
    const v1 = doc.versions.find((v) => v.version === 1);
    if (!v1) throw new Error(`manifest entry ${doc.id} has no version 1`);
    const bytes = await readFile(join(fixturesDir, v1.file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const inserted = await prisma.$transaction(async (tx) => {
      await tx.document.upsert({
        where: { id: doc.id },
        create: { id: doc.id, type: doc.type, title: doc.title },
        update: {},
      });
      const existing = await tx.documentVersion.findUnique({
        where: { documentId_versionNo: { documentId: doc.id, versionNo: 1 } },
        select: { id: true },
      });
      if (existing) return false;

      const version = await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          fileName: basename(v1.file),
          fileBytes: bytes,
          sha256,
          status: "queued",
        },
      });
      await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
      return true;
    });

    (inserted ? result.inserted : result.skipped).push(doc.id);
  }

  return result;
}
