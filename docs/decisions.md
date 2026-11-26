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
