-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('queued', 'extracting', 'extracted', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('running', 'succeeded', 'failed', 'superseded', 'fenced_out');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('approve', 'correct');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_bytes" BYTEA NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "parsed_text" TEXT,
    "status" "VersionStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT,
    "raw_response" JSONB,
    "outcome" "RunOutcome" NOT NULL DEFAULT 'running',
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_values" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB,
    "evidence_text" TEXT,
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "gap_reason" TEXT,
    "previous_value_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "value_id" UUID NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "corrected_value" JSONB,
    "note" TEXT,
    "carried_from_review_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_version_id_key" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "document_versions_status_lease_expires_at_idx" ON "document_versions"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "extraction_runs_version_id_attempt_key" ON "extraction_runs"("version_id", "attempt");

-- CreateIndex
CREATE INDEX "extracted_values_previous_value_id_idx" ON "extracted_values"("previous_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_values_version_id_field_key" ON "extracted_values"("version_id", "field");

-- CreateIndex
CREATE INDEX "reviews_value_id_created_at_idx" ON "reviews"("value_id", "created_at");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_id_fkey" FOREIGN KEY ("previous_value_id") REFERENCES "extracted_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "extracted_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_carried_from_review_id_fkey" FOREIGN KEY ("carried_from_review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants Prisma's schema language cannot express.
-- ---------------------------------------------------------------------------

-- A version being extracted always has a lease, so the reconciler can tell a
-- live claim from a dead one.
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_extracting_has_lease"
    CHECK ("status" <> 'extracting' OR "lease_expires_at" IS NOT NULL);

ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_version_no_positive"
    CHECK ("version_no" >= 1);

-- Evidence or gap: a value is either fully evidenced or a gap with a reason.
-- JSON null is rejected so "gap" has exactly one representation (SQL NULL).
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_evidence_or_gap" CHECK (
    (
        "gap_reason" IS NULL
        AND "value" IS NOT NULL AND jsonb_typeof("value") <> 'null'
        AND "evidence_text" IS NOT NULL
        AND "evidence_start" IS NOT NULL
        AND "evidence_end" IS NOT NULL
        AND 0 <= "evidence_start" AND "evidence_start" < "evidence_end"
    )
    OR (
        "gap_reason" IS NOT NULL
        AND "value" IS NULL
        AND "evidence_start" IS NULL
        AND "evidence_end" IS NULL
    )
);

-- Corrections carry a value; approvals do not.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_correction_has_value" CHECK (
    ("action" = 'correct' AND "corrected_value" IS NOT NULL)
    OR ("action" = 'approve' AND "corrected_value" IS NULL)
);
