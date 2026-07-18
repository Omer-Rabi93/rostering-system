# syntax=docker/dockerfile:1
#
# apps/api HTTP server image.
#
# Stages:
#   base    - Node + pnpm (via corepack), shared by every stage below.
#   pruner  - `turbo prune` cuts the monorepo down to just @rostering/api and the workspace
#             deps it actually needs (@rostering/shared), producing out/json (package.json
#             manifests only, for a cacheable install layer) and out/full (pruned source).
#   builder - installs full (dev+prod) deps from out/json, copies out/full, regenerates the
#             Prisma client fresh (never trust a host-generated client — see .dockerignore),
#             then builds via turbo (which also builds @rostering/shared first, per
#             turbo.json's `dependsOn: ["^build"]`). Ends as non-root. This is what `runtime`
#             copies from below, AND — via `target: builder` in docker-compose.yml — the exact
#             image the one-shot `migrate` service runs `prisma migrate deploy` in.
#
#             Deliberately NOT further pruned to a "prod-only" node_modules: `pnpm prune` is not
#             workspace-recursive (it only inspects the CURRENT package's own manifest), and the
#             workspace ROOT package.json has zero "dependencies" (only devDependencies, for
#             tooling like turbo/eslint) — running `pnpm prune --prod` at the root deletes the
#             *entire* pnpm store, including everything apps/api and packages/shared actually
#             need at runtime (verified the hard way: it did, and `api` crash-looped with
#             `Cannot find package 'express'`). `pnpm deploy` (a different, purpose-built
#             command for exactly this) could produce a true prod-only subset per package, but
#             isn't worth the added complexity here — the devDependencies left in the runtime
#             image (typescript, prisma CLI, vitest, tsx, supertest, eslint, ...) cost some
#             image size, not correctness or security (nothing in them expands the app's actual
#             attack surface at runtime — nothing new listens on a port or executes untrusted
#             input).
#   runtime - node:24-slim, non-root, node_modules + compiled dist/ + package manifests copied
#             from `builder`. This is the image actually run as the `api` (and, for
#             infra/worker.Dockerfile, `worker`) service.
#
# Build from the repo root: `docker build -f infra/api.Dockerfile .`

ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=11.13.1

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# Prisma's engines (schema-engine for `prisma generate`/`migrate deploy`, downloaded during
# `pnpm install`'s postinstall) need OpenSSL to detect the right build; without it they warn and
# silently default to an engine variant that may not match Debian's actual libssl. Installed here
# in `base` (not only in the final `runtime` stage) so `builder` — which both runs `prisma
# generate` and is reused directly as the `migrate` one-shot service's image — has it too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- pruner --------------------------------------------------------------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @rostering/api --docker

# --- builder ---------------------------------------------------------------
FROM base AS builder

# Dummy, non-secret placeholder so `prisma generate`/`prisma.config.ts` (which loads
# process.env.DATABASE_URL via dotenv) has *a* well-formed URL to parse at build time. Never
# used to reach a real database in this stage — actual credentials are injected at container
# run time by docker-compose.yml from the gitignored root .env.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV NODE_ENV=development

# Cacheable dependency layer: only manifests, so this layer only invalidates when a
# package.json/lockfile changes, not on every source edit.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Full pruned source (apps/api + packages/shared + root config).
COPY --from=pruner /app/out/full/ .
# `turbo prune`'s out/full only copies files that belong to the pruned workspace packages
# themselves — root-level shared config that every tsconfig.json `extends` is NOT one of those,
# so it has to be copied explicitly from the real build context (not from out/full).
COPY tsconfig.base.json ./tsconfig.base.json

RUN pnpm --filter @rostering/api exec prisma generate
RUN pnpm exec turbo run build --filter=@rostering/api

# Non-root user, reused by the `migrate` one-shot compose service (see docker-compose.yml) —
# `prisma migrate deploy` needs no elevated privileges.
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --home /app app \
  && chown -R app:app /app
USER app

# --- runtime -----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# Prisma's engines need OpenSSL + CA certs on Debian slim; ca-certificates also covers any
# outbound TLS the app makes. Installed here (not in `base`) so it only lands in images that
# actually run the app, not in the transient pruner/builder stages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --home /app app

WORKDIR /app
ENV NODE_ENV=production

# Everything below comes from `builder` (see its stage comment for why this isn't further
# pruned) so every pnpm-store symlink resolves exactly as it did there. Workspace symlinks
# included: node_modules/@rostering/shared -> ../packages/shared, so apps/api/dist's
# `import '@rostering/shared'` resolves at runtime.
COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/package.json /app/package.json
COPY --from=builder --chown=app:app /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml

COPY --from=builder --chown=app:app /app/apps/api/package.json /app/apps/api/package.json
COPY --from=builder --chown=app:app /app/apps/api/dist /app/apps/api/dist
COPY --from=builder --chown=app:app /app/apps/api/node_modules /app/apps/api/node_modules

COPY --from=builder --chown=app:app /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=builder --chown=app:app /app/packages/shared/dist /app/packages/shared/dist
COPY --from=builder --chown=app:app /app/packages/shared/node_modules /app/packages/shared/node_modules

WORKDIR /app/apps/api
USER app

ENV PORT=3000
EXPOSE 3000

# `/api/health` already exists (Phase 1). Uses Node's built-in fetch so the slim image doesn't
# need curl/wget installed just for this.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
