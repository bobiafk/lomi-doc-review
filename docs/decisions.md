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
