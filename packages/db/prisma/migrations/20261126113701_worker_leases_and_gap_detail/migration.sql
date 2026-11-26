-- AlterEnum
ALTER TYPE "RunOutcome" ADD VALUE 'abandoned';

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "attempts_left" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "extracted_values" ADD COLUMN     "gap_detail" TEXT;

-- Hand-written invariants.
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_attempts_left_non_negative"
    CHECK ("attempts_left" >= 0);

-- Only gaps carry a gap detail.
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_detail_only_on_gaps"
    CHECK ("gap_detail" IS NULL OR "gap_reason" IS NOT NULL);
