# CLAUDE.md — Lomi Labs take-home: document extraction + review

Read this whole file before doing anything in a session. The assignment brief is `ASSIGNMENT.md`
(the original README from Lomi). This file holds the decisions already made; do not silently
deviate from them. If a decision looks wrong, stop and say so instead of working around it.

**Deadline: Saturday 28 November 2026, 23:59 UTC.** Smaller and correct beats bigger and fragile.

## What we're building

PDFs in → text parsed and stored per version → LLM extracts the fields for the document type, each
with a verbatim evidence quote → a human approves or corrects every value → when a new version
arrives, reviews whose evidence didn't change carry over and only changed values go back to pending.

## Stack (pin exact versions in package.json; use current stable releases)

- pnpm workspaces + Turborepo (build, test, lint, typecheck wired through `turbo.json`)
- TypeScript everywhere, strict mode
- API: Fastify · Worker: plain Node process with BullMQ · DB: Postgres + Prisma · Queue: Redis
- Web: Next.js (App Router) + TanStack Query
- PDF text: `unpdf` · LLM: Anthropic SDK, structured output via a tool/JSON schema,
  model from env `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`)
- Validation: Zod (shared between API, worker and web) · Tests: Vitest

## Monorepo layout

```
apps/
  api/        Fastify HTTP API. MUST NOT depend on the LLM SDK or on packages/extraction's LLM client.
  worker/     BullMQ consumer + reconciler. The only place that calls the LLM.
  web/        Next.js review UI.
packages/
  db/         Prisma schema, migrations, client, seed script (reads fixtures/documents.json).
  shared/     Zod schemas, field definitions (from fixtures/expected-fields.json), status enums, API DTOs.
  extraction/ Pure logic: text normalization, prompt builder, LLM response parsing, evidence
              validation, carry-over diff. No DB, no Redis. Most unit tests live here.
  config/     Shared tsconfig + eslint config.
fixtures/     Provided by Lomi. Do not modify. (v2 invoice file is `invoice-001.v2.pdf`.)
```

Boundary rule: `apps/api` never imports the LLM client. That makes "upload never waits for the LLM"
true by construction.

## Non-negotiable invariants (each one needs a test or a scripted check)

1. **Postgres is the system of record. Redis is a doorbell.** Status, attempts, errors, leases,
   values, reviews and run logs live in Postgres. Losing all of Redis must lose nothing.
2. **Commit, then enqueue.** Upload writes the version row (status `queued`) in a transaction, then
   enqueues with `jobId = versionId`. If enqueue fails, the reconciler catches it.
3. **Atomic claim with a lease.** The worker claims a version with a single conditional UPDATE:
   `status='queued' OR (status='extracting' AND lease_expires_at < now())` → set `extracting`,
   increment `attempt`, set `lease_expires_at`, RETURNING. Zero rows → another worker owns it; exit.
   Heartbeat extends the lease while the LLM call runs.
4. **Fenced commit.** Values + status `extracted` are written in ONE transaction, and only if the row
   still has this worker's `attempt` and isn't `superseded`. Unique `(version_id, field)` on values.
   A second run of the same version can never duplicate values.
5. **Reconciler.** Runs on worker startup and every 30s: re-enqueues versions that are `queued`, or
   `extracting` with an expired lease. Handles restarts, killed containers and `FLUSHALL`.
6. **Failure is a state.** Parse/LLM/schema errors → status `failed`, `last_error` set, run recorded.
   Retry endpoint moves `failed` → `queued` and enqueues. Cap automatic retries; manual retry always allowed.
7. **Evidence or gap.** After normalizing whitespace on both sides, the evidence quote must be an exact
   substring of THIS version's stored `parsed_text`. If not → store a gap (`value: null`,
   `gap_reason: 'evidence_not_found'`). Field not found by the LLM → gap with the LLM's reason.
   Never keep an unverified value. Store evidence char offsets for highlighting.
8. **Every run is logged.** `extraction_runs` stores prompt, raw response, model, timings, outcome, error.
9. **Nothing is deleted.** Old versions, their values and reviews stay queryable.

## Schema sketch (refine in Prisma, keep the relationships)

- `documents` — id (manifest id like `doc-invoice-001`), type, title, current_version_id
- `document_versions` — id, document_id, version_no, file_bytes (bytea), sha256, parsed_text,
  status (`queued|extracting|extracted|failed|superseded`), attempt, lease_expires_at, last_error,
  created_at · unique(document_id, version_no)
- `extraction_runs` — id, version_id, attempt, model, prompt, raw_response, outcome, error, started_at, finished_at
- `extracted_values` — id, version_id, run_id, field, value (jsonb, nullable), evidence_text,
  evidence_start, evidence_end, gap_reason, previous_value_id (nullable, set when re-extracted)
  · unique(version_id, field)
- `reviews` — id, value_id, action (`approve|correct`), corrected_value (jsonb), note,
  carried_from_review_id (nullable), created_at · append-only; latest row per value is current

Document status shown in the API = its current version's status.

**Review state of a value (derived, not stored):** no review → `pending`; latest review has
`carried_from_review_id` → `carried_over`; else `approved` or `corrected`. Gaps start `pending` too:
a reviewer can approve a gap (confirm it's absent) or correct it (supply the value).

**Correction model:** corrections are annotations beside the extracted value. The extracted value and
its evidence never change. Effective value = latest correction ?? extracted value. API and UI must
both reflect this model.

## Re-extraction and carry-over

- Compare against the **latest version with status `extracted`** (not just version N-1).
- Per field, carry over the old review if BOTH hold:
  1. normalized new value equals normalized old value (dates ISO, money as cents, percent as number), and
  2. the old evidence quote (normalized) still appears verbatim in the new version's parsed text.
- Carried over → copy the review as a new row with `carried_from_review_id`. Otherwise the value is
  `pending`, and `previous_value_id` links to the old value so the UI can show old value + old review.
- Old value had no review → nothing to carry; new value is simply pending.
- Acceptance test with real fixtures: after v2 of the invoice, exactly `due_date` and `total_amount`
  are pending; `invoice_number`, `issue_date`, `vendor_name` are carried over.

**New version while the previous one is extracting: supersede.** The new version becomes current.
The in-flight version is marked `superseded`; its fenced commit then fails and its result is discarded
(the run is still logged with outcome `superseded`). Document this in the README.

## API

- `POST /documents` (multipart: type, file, optional title) → 202 with document + version, status `queued`
- `POST /documents/:id/versions` (multipart: file) → 202
- `GET /documents` → list with status, current version, progress counts
- `GET /documents/:id` → current version, status, values with evidence, review state, previous value/review
- `GET /documents/:id/versions/:versionNo` → any historical version, same shape
- `POST /documents/:id/retry` → re-queue a failed current version
- `POST /values/:id/review` → `{ action: 'approve' } | { action: 'correct', value, note? }`
- `GET /documents/:id/progress` → `{ pending, approved, corrected, carriedOver, gaps }`

Validate every input with Zod from `packages/shared`. Return consistent error JSON.

## UI

- List: title, type, status badge, version, progress bar. Poll with TanStack Query
  `refetchInterval` ONLY while any document is `queued`/`extracting`; otherwise stop.
- Detail: values that need attention first (pending, gaps), then carried over, then approved/corrected.
  Each row: field, value, evidence quote, state badge, approve/correct actions. Gaps show their reason.
  Changed values show previous value + previous review beside the new one. Failed docs show the error + retry.
- Nice-to-have only if time allows: highlight the quote inside the version's text.
- Goal: a reviewer knows what needs attention within five seconds.

## Docker

`docker compose up` at the root starts postgres, redis, api, worker, web. Healthchecks + `depends_on:
condition: service_healthy`. A one-shot `migrate` service runs `prisma migrate deploy` then the seed.
The seed is idempotent (upsert by manifest id) and inserts **only v1** of each document as `queued`, so
the reconciler extracts them. `ANTHROPIC_API_KEY` comes from `.env` (commit `.env.example`, never `.env`).

## Phases (do one at a time; tick off here when done)

- [x] 1. Scaffold: workspaces, turbo pipeline, packages, compose with postgres + redis, CI-able `pnpm turbo build test lint`
- [ ] 2. Prisma schema, migrations, seed from manifest
- [ ] 3. `packages/extraction` test-first: normalization, evidence validation, gap rules, carry-over diff (with real fixture text)
- [ ] 4. Worker: claim/lease/heartbeat, LLM call, fenced commit, run logging, reconciler, failure + retry
- [ ] 5. API endpoints + progress
- [ ] 6. Web UI: list, detail, review actions, carry-over display
- [ ] 7. Chaos pass: kill worker mid-extraction, `FLUSHALL` + restart, double upload, v2 during v1. Write results in `docs/chaos.md`
- [ ] 8. README for a new engineer (see brief section 7) + final cleanup

Cut order if short on time: quote highlighting → deployment → UI polish. Never cut phases 3, 4 or 7.

## Tests (test what's most likely to break)

Priority: evidence validation (whitespace, line breaks, hallucinated quotes), carry-over with the real
invoice v1/v2 text, idempotent commit (same version twice → one set of values), supersede race,
reconciler picks up stale leases, API contract for review. LLM calls are mocked in tests via an
injectable client interface; one optional live smoke test behind an env flag.

## Working rules for Claude

- One phase (or a clearly scoped part of one) per session. Start by restating the plan for the step.
- Commit at every green checkpoint, small and focused, Conventional Commits:
  `feat(worker): reconcile stale leases on startup`, `test(extraction): carry-over on invoice v2`,
  `fix(api): ...`, `chore(repo): ...`, `docs(readme): ...`. Run `pnpm turbo build test lint` before committing.
- Show me the diff summary and proposed commit message; I approve before you commit.
- When you make a design choice not covered here, add it to `docs/decisions.md` (one short entry:
  decision, alternatives, why). These feed the README and my Loom video.
- No dead code, no TODOs without a matching line in the README's "what I'd do next".
- Never commit secrets, `.env`, or session logs.
