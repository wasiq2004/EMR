# syntax=docker/dockerfile:1

# =============================================================================
# Web image
#
# Next.js standalone output: the runtime carries a self-contained server and
# only the modules it actually imports, which is a fraction of node_modules.
# =============================================================================

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependencies ------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json           apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @emr/web... --filter @emr/contracts...

# --- build -------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web           apps/web
RUN pnpm --filter @emr/web build

# --- runtime -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# HOSTNAME must be pinned. Next's standalone server binds to `process.env
# .HOSTNAME || '0.0.0.0'`, and Docker sets HOSTNAME to the container id — so
# without this the server binds to the container's own name. Published ports
# still work, which is what makes it confusing: the site is reachable from the
# host and unreachable from inside the container, so the health check fails
# forever and anything on the same network that talks to it by loopback breaks.
ENV HOSTNAME=0.0.0.0 PORT=3000

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public           ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
