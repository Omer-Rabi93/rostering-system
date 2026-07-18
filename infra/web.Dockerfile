# syntax=docker/dockerfile:1
#
# apps/web static SPA build, packaged into the nginx image that actually serves it. There is no
# standalone "web" service in docker-compose.yml — this Dockerfile's `build` stage produces the
# static bundle, and its `runtime` stage (nginx + infra/nginx.conf) IS the `nginx` compose
# service's image. "Build stage only, output consumed by nginx" (per the implementation plan)
# means: this file's only real job is producing apps/web/dist; nginx is what serves it.
#
# Build from the repo root: `docker build -f infra/web.Dockerfile .`

ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=11.13.1
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# --- pruner ------------------------------------------------------------
# apps/web depends on @rostering/shared and @rostering/ui (workspace:*) in package.json, so
# turbo prune includes both — even though vite.config.ts/tsconfig.json alias both straight to
# their `src/index.ts` (not `dist/`), so this build never actually needs those packages' own
# `tsup` builds to run; it only needs their source + their own node_modules (e.g. zod, react)
# installed, which `pnpm install` below provides via the normal workspace symlinks.
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @rostering/web --docker

# --- build -------------------------------------------------------------
FROM base AS build

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# See infra/api.Dockerfile's `builder` stage: root-level tsconfig.base.json isn't part of
# `turbo prune`'s out/full, so it's copied explicitly from the real build context — needed for
# apps/web's own `tsc --noEmit` step (its tsconfig.json extends it too).
COPY tsconfig.base.json ./tsconfig.base.json

RUN pnpm --filter @rostering/web run build

# --- runtime (nginx) -----------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# The stock nginx:alpine image already runs its master process as root but its worker
# processes as the unprivileged `nginx` user by default; nothing further to drop here.

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1/"]

CMD ["nginx", "-g", "daemon off;"]
