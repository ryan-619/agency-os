# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not apps/web — this is a workspace build and
# the image needs packages/core and packages/db too. See docker-compose.yml.
#
# npm workspaces hoist every dependency into the ROOT node_modules and symlink
# the workspaces themselves as node_modules/@agency/* -> ../../packages/*.
# There are no per-package node_modules directories to copy.

# --- deps: install once against the whole workspace ------------------------
FROM node:22-alpine AS deps
WORKDIR /app
# Every workspace package.json is copied even though this image only runs the
# web app. Not because npm ci fails without one — it does NOT, it silently
# creates a dangling symlink and exits 0 — but because the failure then
# surfaces at run time as ERR_MODULE_NOT_FOUND with nothing red in the build.
# apps/web declares @agency/scanner, so its package.json belongs here.
COPY package.json package-lock.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/scanner/package.json packages/scanner/
COPY apps/web/package.json         apps/web/
COPY apps/agent/package.json       apps/agent/
RUN npm ci

# --- build: compile the workspace packages, then Next ----------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# packages/core and packages/db compile to dist/ and are consumed as JavaScript.
RUN npx tsc --build
ENV NEXT_TELEMETRY_DISABLED=1
# No secrets here on purpose: apps/web/src/lib/db.ts is lazy so that `next
# build` can collect page data without DATABASE_URL/AUTH_SECRET/SMTP_HOST.
RUN npm run build --workspace @agency/web

# --- run: the standalone server -------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# `output: standalone` with outputFileTracingRoot at the repo root emits a tree
# rooted at .next/standalone: apps/web/server.js plus a pruned node_modules.
# Static assets are NOT included and must be copied separately.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
