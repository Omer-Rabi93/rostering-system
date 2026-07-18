# syntax=docker/dockerfile:1
#
# pg-boss background worker image: runs the compiled apps/api/src/worker.ts (`node dist/worker.js`)
# — the `csv-import` + `roster-generation` job handlers, plus the next-month generation cron.
#
# Same TypeScript build pipeline as infra/api.Dockerfile (see that file's `builder` stage
# comment for why the runtime node_modules is NOT further pruned to prod-only — `pnpm prune`
# isn't workspace-recursive and wiped the entire store the one time this was tried); the only
# real difference is this image also needs Python 3 + OR-Tools to run solver/solve_roster.py,
# which `apps/api/src/engine/runSolver.ts` spawns as a subprocess
# (`spawn(pythonExecutable, [scriptPath], { shell: false })`, problem JSON over stdin only).
# Installed into a container-local venv (Debian's system Python 3.11 refuses `pip install`
# outside a venv — PEP 668 "externally-managed-environment" — and a venv also keeps the
# solver's deps cleanly isolated from anything Node/npm-related in the image).
#
# Build from the repo root: `docker build -f infra/worker.Dockerfile .`

ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=11.13.1

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# See infra/api.Dockerfile's `base` stage comment: OpenSSL is required for Prisma's engine
# postinstall/`prisma generate` to work correctly, needed here too since `builder` runs both.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- pruner ------------------------------------------------------------
# Same @rostering/api target as infra/api.Dockerfile: worker.ts lives inside apps/api/src and
# shares its package.json/dependency graph — there is no separate "@rostering/worker" package.
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @rostering/api --docker

# --- builder -------------------------------------------------------------
FROM base AS builder

# Dummy, non-secret placeholder — see infra/api.Dockerfile's builder stage comment.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV NODE_ENV=development

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# See infra/api.Dockerfile's `builder` stage: root-level tsconfig.base.json isn't part of
# `turbo prune`'s out/full, so it's copied explicitly from the real build context.
COPY tsconfig.base.json ./tsconfig.base.json

RUN pnpm --filter @rostering/api exec prisma generate
RUN pnpm exec turbo run build --filter=@rostering/api

# Non-root user (same policy as infra/api.Dockerfile) — created here so the Node dependency
# layers copied into `runtime` below are already owned correctly.
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --home /app app \
  && chown -R app:app /app
USER app

# --- runtime -----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# openssl/ca-certificates: same Prisma requirement as infra/api.Dockerfile.
# python3 + python3-venv: to run solver/solve_roster.py.
# build-essential is deliberately NOT installed: ortools ships manylinux wheels, so no
# source compilation is needed and skipping it keeps the image meaningfully smaller.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --home /app app

# Container-local venv with OR-Tools baked in at build time (not created/populated at container
# start), owned by the non-root app user so it needs no runtime privilege escalation.
ENV VENV_PATH=/opt/venv
RUN python3 -m venv ${VENV_PATH} && chown -R app:app ${VENV_PATH}
ENV PATH="${VENV_PATH}/bin:${PATH}"
# `runSolver.ts` reads $SOLVER_PYTHON_PATH (falling back to plain `python3` on PATH otherwise);
# set it explicitly so the solver always runs inside this venv rather than depending on PATH
# ordering alone.
ENV SOLVER_PYTHON_PATH=${VENV_PATH}/bin/python3

WORKDIR /app/solver
COPY solver/requirements.txt ./requirements.txt
USER app
RUN pip install --no-cache-dir -r requirements.txt
USER root

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/package.json /app/package.json
COPY --from=builder --chown=app:app /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml

COPY --from=builder --chown=app:app /app/apps/api/package.json /app/apps/api/package.json
COPY --from=builder --chown=app:app /app/apps/api/dist /app/apps/api/dist
COPY --from=builder --chown=app:app /app/apps/api/node_modules /app/apps/api/node_modules

COPY --from=builder --chown=app:app /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=builder --chown=app:app /app/packages/shared/dist /app/packages/shared/dist
COPY --from=builder --chown=app:app /app/packages/shared/node_modules /app/packages/shared/node_modules

# The solver script itself. `runSolver.ts`'s DEFAULT_SOLVER_SCRIPT_PATH resolves it relative to
# its own compiled file location (apps/api/dist/engine/runSolver.js -> ../../../../solver/solve_roster.py)
# — i.e. it expects the exact same repo-root-relative layout inside the container, which WORKDIR
# /app plus this path preserves.
COPY --chown=app:app solver/solve_roster.py /app/solver/solve_roster.py

WORKDIR /app/apps/api
USER app

# No HTTP server here (this process only polls Postgres via pg-boss), so there is nothing for a
# Docker HEALTHCHECK to probe over HTTP; container liveness is covered by Docker's normal
# process-exit-code restart handling (`restart: unless-stopped` in docker-compose.yml) instead.

CMD ["node", "dist/worker.js"]
