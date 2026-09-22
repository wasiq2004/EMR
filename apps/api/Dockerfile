# syntax=docker/dockerfile:1

# =============================================================================
# API image
#
# Multi-stage, so the runtime carries the compiled output and production
# dependencies only — no source, no toolchain, no dev packages.
# =============================================================================

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependencies ------------------------------------------------------------
# Copied before the source so a source change does not invalidate the install
# layer. argon2 needs a toolchain to build its native binding.
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json      apps/api/
COPY packages/db/package.json   packages/db/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @emr/api... --filter @emr/db... --filter @emr/contracts...

# --- build -------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/db        packages/db
COPY apps/api           apps/api
RUN pnpm --filter @emr/api build

# --- runtime -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

# Runs unprivileged. The node image ships a `node` user for exactly this.
RUN mkdir -p /var/lib/emr/objects && chown -R node:node /var/lib/emr

COPY --from=build --chown=node:node /app/node_modules          ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist         ./dist
COPY --from=build --chown=node:node /app/packages              ./packages
COPY --from=build --chown=node:node /app/apps/api/package.json ./package.json

USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
