# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT. See docker-compose.yml.
# This image also carries the migration and seed CLIs, which docker-compose
# runs as one-off `migrate` and `seed` task services.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/scanner/package.json packages/scanner/
COPY packages/tools/package.json   packages/tools/
COPY apps/web/package.json         apps/web/
COPY apps/agent/package.json       apps/agent/
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc --build

# --- run: production dependencies only ------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production AGENT_PORT=3001

RUN addgroup -g 1001 -S nodejs && adduser -S agent -u 1001

# Reinstall without devDependencies. Every workspace package.json is needed for
# npm creates the node_modules/@agency/* symlinks that let `import '@agency/db'`
# resolve to packages/db/dist. EVERY workspace package.json must be copied —
# not because npm ci fails without one (it does NOT: it silently creates a
# dangling symlink and exits 0) but because the failure surfaces at run time
# instead, as ERR_MODULE_NOT_FOUND from inside a container, with nothing red in
# the build. packages/scanner was missing here until Phase 2 needed it.
COPY package.json package-lock.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/scanner/package.json packages/scanner/
COPY packages/tools/package.json   packages/tools/
COPY apps/web/package.json         apps/web/
COPY apps/agent/package.json       apps/agent/
RUN npm ci --omit=dev --workspace @agency/agent --include-workspace-root

COPY --from=build --chown=agent:nodejs /app/packages/core/dist    ./packages/core/dist
COPY --from=build --chown=agent:nodejs /app/packages/db/dist      ./packages/db/dist
COPY --from=build --chown=agent:nodejs /app/packages/scanner/dist ./packages/scanner/dist
COPY --from=build --chown=agent:nodejs /app/packages/tools/dist   ./packages/tools/dist
COPY --from=build --chown=agent:nodejs /app/apps/agent/dist       ./apps/agent/dist
# The migration CLI reads these off disk at run time.
COPY --chown=agent:nodejs packages/db/migrations ./packages/db/migrations
COPY --chown=agent:nodejs packages/db/seed       ./packages/db/seed

USER agent
# 3001 is health; 3002 is the internal API the web app calls. Neither is
# published to the host by docker-compose.yml — 3001 is bound to loopback
# there and 3002 is reachable only over the compose network.
EXPOSE 3001 3002

# /readyz, not /livez. A liveness probe answers "the process is running",
# which stays true when the runtime has HALTED because a tool ran that the
# gate never authorised — the one condition an operator most needs to see.
# /readyz reports it, along with an unreachable database.
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/agent/dist/index.js"]
