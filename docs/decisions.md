# Decisions

Design choices not already fixed in `CLAUDE.md`. One entry each: decision, alternatives, why.

## Library packages compile to `dist/` with `tsc`

- **Decision:** `packages/*` build to `dist/` and export compiled JS + `.d.ts`. Apps depend on the built output; Turborepo's `^build` orders it.
- **Alternatives:** "internal packages" that export `.ts` source and rely on each consumer (tsx, Next `transpilePackages`) to compile it.
- **Why:** the API and worker run as plain `node dist/...` in Docker with no runtime transpiler, and the build graph in `turbo.json` does real work instead of being decorative.

## Field definitions are a typed literal, checked against the fixture

- **Decision:** `packages/shared/src/fields.ts` holds the per-type field list as a `const` literal; a test asserts it deep-equals `fixtures/expected-fields.json`.
- **Alternatives:** import the JSON at build time, or read it at runtime.
- **Why:** a literal gives a closed `DocumentType` union the compiler checks everywhere; the JSON sits outside every package's `rootDir`. The test makes drift impossible to miss.

## TypeScript pinned to 6.0.x, not 7

- **Decision:** `typescript@6.0.3`.
- **Alternatives:** TypeScript 7 (native compiler).
- **Why:** `typescript-eslint@8.74` supports `<6.1`. Lint working beats a faster compiler for a project this size.

## Prisma pinned to the 7.x line

- **Decision:** use `prisma`/`@prisma/client` 7.10.1 (phase 2).
- **Alternatives:** `prisma@latest`, which currently points at `8.0.0-rc.36`.
- **Why:** the npm `latest` tag is a release candidate; a take-home should run on a stable release.

## Dependencies must be at least a day old

- **Decision:** keep pnpm 12's default `minimumReleaseAge` gate and pin versions that pass it (e.g. `vitest@5.1.1` instead of `5.1.2`, published the day before scaffolding). No `minimumReleaseAgeExclude` entries.
- **Alternatives:** let pnpm add exclusions for the newest releases.
- **Why:** freshly published versions are the main supply-chain attack window; the newest patch is never worth bypassing that.

## Prisma 7 with the `pg` driver adapter; client generated into `packages/db/src/generated`

- **Decision:** `prisma-client` generator (ESM, `.js` import extensions) output inside the db package, compiled with the rest of `src`; `createPrismaClient(url)` wires `@prisma/adapter-pg`. A `generate` turbo task runs before build/typecheck/test/lint. The generated client is gitignored.
- **Alternatives:** the legacy `prisma-client-js` generator into `node_modules`.
- **Why:** Prisma 7's default. No native query engine means no `binaryTargets` juggling between Windows dev and Linux containers.

## Invariants Prisma can't express are CHECK constraints in the migration

- **Decision:** the init migration adds hand-written CHECKs: evidence-or-gap on `extracted_values` (a value has evidence text + offsets, a gap has a reason and SQL-NULL value; JSON `null` is rejected), correction-has-value on `reviews`, extracting-has-lease on `document_versions`. A gap may keep the LLM's (unverified) `evidence_text` for debugging. Prisma ignores CHECKs when diffing, so they don't cause drift.
- **Alternatives:** enforce only in application code.
- **Why:** "never keep an unverified value" holds even if a future code path forgets the rule. Tests assert each constraint fires.

## Document `type` is text, statuses are Postgres enums

- **Decision:** `documents.type` is `text`, validated by `DocumentTypeSchema` at the edges. `VersionStatus`, `RunOutcome`, `ReviewAction` are Postgres enums.
- **Alternatives:** an enum for type too.
- **Why:** the type list comes from `expected-fields.json`; adding a type should be a code change, not a migration. Statuses are the state machine and belong to the schema.

## `extraction_runs.outcome` distinguishes `superseded` from `fenced_out`

- **Decision:** `running | succeeded | failed | superseded | fenced_out`; unique `(version_id, attempt)`.
- **Alternatives:** a single "discarded" outcome.
- **Why:** "a newer version arrived" and "this worker lost its lease to another attempt" are different stories when debugging a run log.

## The seed never resets an existing version

- **Decision:** the seed upserts the document by manifest id and inserts version 1 only if missing; an existing version 1 is untouched whatever its status.
- **Alternatives:** upsert that resets status to `queued`.
- **Why:** the migrate service runs on every `docker compose up`; resetting would re-extract and orphan reviews on every restart.

## Database tests run against real Postgres, one cloned database per test file

- **Decision:** vitest `globalSetup` applies migrations with `prisma migrate deploy` to a template DB; each test file clones it (`CREATE DATABASE … TEMPLATE …`) and drops it after. CI runs a Postgres service container.
- **Alternatives:** mocking Prisma, or one shared DB with truncation.
- **Why:** the invariants (unique keys, CHECKs, the conditional claim UPDATE in phase 4) only mean something against Postgres. Clones keep files isolated and parallel.

## Compose host ports default to 25432 / 26379

- **Decision:** `${POSTGRES_HOST_PORT:-25432}` and `${REDIS_HOST_PORT:-26379}`; containers talk to each other on the default ports.
- **Alternatives:** 5432 / 6379 on the host.
- **Why:** a locally installed Postgres or Redis on the default ports silently captures `localhost` connections (it happened on the dev machine). Off-default ports make "connected to the wrong database" impossible.

## One multi-target Dockerfile

- **Decision:** a root `Dockerfile` with a shared `deps`/`source` stage and one target per service (`migrate` now; api/worker/web later).
- **Alternatives:** a Dockerfile per app with `turbo prune`.
- **Why:** one lockfile fetch layer shared by every service, and one place to read. `turbo prune` is the next step if image size matters.

## unpdf pinned to 1.9.1; runtime stays on Node 22

- **Decision:** `unpdf@1.9.1`.
- **Alternatives:** `unpdf@2.x` (requires Node >= 24; on Node 22 it hangs), or moving everything to Node 24.
- **Why:** Node 22 is what the dev machine, CI and the Docker base image run today; 1.9.1 extracts the fixtures cleanly. Moving to Node 24 + unpdf 2 is a one-line change in each place later.

## Evidence matching: NFKC + whitespace collapse, case-sensitive, offsets mapped back

- **Decision:** both the quote and the document text are normalized per code point (NFKC) with whitespace runs collapsed; the quote must then be an exact, case-sensitive substring. A position map turns the match back into offsets in the original `parsed_text`, and the stored `evidence_text` is that exact original slice, not the model's quote.
- **Alternatives:** raw substring (breaks on PDF line wraps), fuzzy matching (lets paraphrases through), case-insensitive matching.
- **Why:** PDF extraction wraps lines and emits ligatures, models don't; everything else must stay verbatim or the hallucination defense is meaningless. Missing whitespace ("Net30" vs "Net 30") is not forgiven.

## The quote must contain the value (`value_not_in_evidence`)

- **Decision:** after the quote is found, the normalized value must appear in it (numbers/amounts by numeric match, dates by ISO or a common written form, strings case-insensitively). Otherwise the field is a gap with `value_not_in_evidence`.
- **Alternatives:** only check that the quote exists, as the brief requires.
- **Why:** a model can quote the right line and report the wrong number. This catches it for the cost of a few regexes.

## The model returns canonical values; normalization rejects instead of guessing

- **Decision:** the tool schema asks for ISO dates, plain decimals and an ISO currency code. Normalization is strict: anything else is an `invalid_value` gap. Money is `{ cents, currency }`, percent is percentage points.
- **Alternatives:** parse whatever format the model returns (date libraries, number words).
- **Why:** the model is good at reformatting; our code is good at checking. A strict, small normalizer is easy to trust and test, and carry-over compares these normalized values.

## Gap reasons are a closed set

- **Decision:** `not_found` (model's reason kept in `gapDetail`), `not_returned`, `invalid_value`, `evidence_not_found`, `value_not_in_evidence`, defined in `packages/shared`.
- **Alternatives:** free-text reasons.
- **Why:** the UI and progress counts can group and explain gaps; free text still lives in `gapDetail`. Needs a `gap_detail` column (added with the worker in phase 4).

## Gaps never carry a review over

- **Decision:** a review is carried only between two evidenced values. If either side is a gap, the new value is pending.
- **Alternatives:** carry "confirmed absent" approvals between gaps.
- **Why:** a gap has no evidence to compare, so "evidence unchanged" cannot be shown. Re-confirming an absence is cheap; silently carrying a stale correction onto a gap is not.

## A malformed field entry fails the whole run; a missing field is a gap

- **Decision:** an entry with the wrong shape throws `ExtractionResponseError` (the version goes to `failed`, retryable). A field the model omitted becomes a `not_returned` gap; unknown fields are ignored.
- **Alternatives:** fail on any deviation, or salvage everything.
- **Why:** a broken entry means the response can't be trusted; an omission is a normal, reviewable outcome.

## Structured JSON output instead of a forced tool call

- **Decision:** the extraction request uses `output_config.format` (JSON schema built per document type) and parses the text block. `@lomi/extraction` builds the schema; the worker owns the SDK call.
- **Alternatives:** a tool with forced `tool_choice` (the original plan).
- **Why:** Claude Sonnet 5.5 returns 400 on forced `tool_choice`, and a tool call only existed to get JSON back. Our own validation still runs after the schema-constrained output, because schema-valid is not the same as true.

## Refusal fallback on, effort medium

- **Decision:** `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) and `effort: "medium"`. The run stores the model that actually answered.
- **Alternatives:** no fallback (a refusal fails the version); default effort (`high` on Sonnet 5.5).
- **Why:** a false-positive safety decline on an invoice would otherwise need a human retry; one-page documents with a fixed schema don't need `high`.

## Automatic retries live in Postgres, not BullMQ

- **Decision:** `attempts_left` (3, refilled by a manual retry) and `available_at` (backoff) on the version. Transient LLM errors (429, 5xx, network) re-queue with exponential backoff until attempts run out; everything else fails at once. BullMQ jobs use `attempts: 1` and are removed when done.
- **Alternatives:** BullMQ's built-in `attempts`/`backoff`.
- **Why:** retry state in Redis disappears on `FLUSHALL`; in Postgres the reconciler can always see and resume it, and a user can see "attempt 2 of 3".

## Lease heartbeat aborts the LLM call when the lease is lost

- **Decision:** while an attempt runs, the worker extends its lease every `HEARTBEAT_MS` with a fenced UPDATE; if that is refused (superseded, or re-claimed after a stall) it aborts the in-flight LLM request.
- **Alternatives:** only rely on the fenced commit.
- **Why:** the fenced commit already guarantees correctness; the abort saves tokens and frees the worker early when a new version arrives.

## One run row per claim; the reconciler marks dead runs `abandoned`

- **Decision:** a run row is written right after the claim and finished with an outcome. A run whose worker died (lease expired or a later attempt exists) is marked `abandoned` by the reconciler.
- **Alternatives:** write the run only at the end.
- **Why:** "every run is logged", including the ones that never finished; a crash shows up in the run history instead of as a silent gap.

## `@lomi/jobs` holds the queue contract

- **Decision:** queue name, job payload schema and `enqueueExtraction` (jobId = versionId, removed on completion) live in a small package used by both API and worker.
- **Alternatives:** duplicate the constants, or put them in `@lomi/shared` (which the web app also imports).
- **Why:** the API must enqueue without depending on the worker or the LLM SDK, and the web bundle should never pull in BullMQ.

## Test database helpers are exported as `@lomi/db/testing`

- **Decision:** the template-database global setup and `createTestDatabase()` ship from the db package; the worker (and API) reuse them. The Prisma CLI is resolved from the db package, not `PATH`.
- **Alternatives:** copy the helpers into each app.
- **Why:** one place that knows how to stand up a migrated database.

## Carry-over is planned from the previous version as it was at extraction time

- **Decision:** the worker loads the previous version's values and latest reviews just before the commit.
- **Alternatives:** lock the previous version's reviews during extraction.
- **Why:** the window is a few seconds. A review made on the old version in that window stays on the old version (visible in history) and is not copied forward; recorded as a known edge case.

## Re-uploading the current file is a no-op

- **Decision:** `POST /documents/:id/versions` with a file whose sha256 equals the current version's returns `200 { duplicate: true }` and creates nothing. Concurrent uploads to one document are serialized with `SELECT … FOR UPDATE` on the document row.
- **Alternatives:** always create a version; reject duplicates with 409.
- **Why:** an impatient double-click or a client retry should not create a version, supersede in-flight work and spend another LLM call. Returning the existing version keeps the client simple.

## Only the current version's values can be reviewed

- **Decision:** reviewing a value of a non-current version returns `409 not_current_version`.
- **Alternatives:** allow reviews on any version.
- **Why:** a review on an old version would never be seen by the current one; carry-over flows forward only. Old versions stay readable through `GET /documents/:id/versions/:n`.

## Corrections are normalized on the server, with the extraction rules

- **Decision:** `{ action: "correct", value }` accepts what a reviewer types ("$6,126.45", "4.2%") and normalizes it with the same `normalizeValue` the worker uses; invalid input is `422 invalid_value`. The API imports `@lomi/extraction` for this (pure code: no LLM SDK; the client lives in the worker).
- **Alternatives:** store the raw string; normalize in the browser.
- **Why:** carry-over and the UI compare normalized values; a correction must have the same shape as an extracted value.

## Progress buckets are disjoint; `gaps` means gaps awaiting review

- **Decision:** `total = pending + gaps + approved + corrected + carriedOver`. A reviewed gap counts in its review bucket.
- **Alternatives:** count gaps separately from review state (overlapping numbers).
- **Why:** a progress bar needs parts that add up, and "gaps waiting for you" is what a reviewer acts on.

## The API's Redis client fails fast

- **Decision:** `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`; an enqueue failure is logged and the upload still returns 202.
- **Alternatives:** ioredis defaults (commands buffer until Redis is back).
- **Why:** with defaults an upload hangs while Redis is down. The version is already committed, so the reconciler enqueues it within one interval. Verified: upload with Redis stopped returned 202 in 30 ms.

## Upload limits

- **Decision:** one file, at most 10 MB, must start with `%PDF-` (`415 not_a_pdf` otherwise). Uploaded documents get ids `doc-<uuid>`; seeded ones keep their manifest ids.
- **Why:** cheap checks at the edge; anything subtler (encrypted, scanned) is caught by the worker's parser and becomes a visible `failed`.

## The UI polls, and only while something is in flight

- **Decision:** TanStack Query `refetchInterval` of 2 s on the list while any document is `queued`/`extracting`, and on a document page while its version is; otherwise no polling at all. Mutations invalidate the affected queries.
- **Alternatives:** SSE/WebSockets pushed from the worker; manual refresh.
- **Why:** extraction takes seconds and changes one status field. Push would need a channel from the worker through the API to the browser for a handful of state changes; bounded polling is simpler and stops by itself.

## The browser talks to one origin: Next rewrites `/api/*` to Fastify

- **Decision:** `next.config` rewrites `/api/:path*` to `API_URL` (baked in at build time; `turbo.json` declares `API_URL` so it reaches `next build` and the cache key).
- **Alternatives:** CORS on the API with a public API URL in the client bundle.
- **Why:** no CORS configuration, no API URL in client code, and the API stays an internal service in Compose.

## Review page layout: attention first, quote beside value, document text alongside

- **Decision:** groups "Needs your review" (changed values first, then pending, then gaps), "Carried over", "Reviewed". Each row shows the effective value, the verified quote, and for changed values the v(N-1) value and review. A side panel shows the version's parsed text with the focused value's quote highlighted (from the stored offsets). Old versions open read-only with a banner.
- **Why:** the five-second test: the top line and first group say what needs you; the quote and highlighted passage let a reviewer verify without opening the PDF.

## Dev-only canned LLM (`EXTRACTION_LLM=canned`)

- **Decision:** a stand-in `ExtractionLlm` that returns fixed answers for the four fixture PDFs (and `not_found` gaps for anything else). Runs record model `canned-dev`. The default remains the Anthropic client, and the worker refuses to start without a key unless canned is chosen explicitly.
- **Alternatives:** writing values straight into the database for UI work.
- **Why:** it exercises the real pipeline after the LLM call (evidence validation, carry-over, fenced commit), so UI work and demos use real data paths while the API account has no credit.
