# syntax=docker/dockerfile:1
# One Dockerfile for the monorepo; each service is a build target.

FROM node:22.13.0-slim AS base
# openssl: required by Prisma's schema engine (migrate deploy).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.23.0
WORKDIR /repo

# Download every dependency from the lockfile alone, so source edits don't bust this layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM deps AS source
COPY . .
# Not --offline: pnpm 12 checks lockfile metadata against its supply-chain policy.
RUN pnpm install --frozen-lockfile

# One-shot: apply migrations, then the idempotent seed (v1 of each fixture, queued).
FROM source AS migrate
RUN pnpm turbo run build --filter=@lomi/db
WORKDIR /repo/packages/db
ENV FIXTURES_DIR=/repo/fixtures \
    PRISMA_HIDE_UPDATE_MESSAGE=1
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/bin/seed.js"]

# BullMQ consumer + reconciler. The only service that talks to the LLM.
FROM source AS worker
RUN pnpm turbo run build --filter=@lomi/worker...
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/main.js"]

# HTTP API. Never calls the LLM: uploads commit, ring the queue, return 202.
FROM source AS api
RUN pnpm turbo run build --filter=@lomi/api...
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
