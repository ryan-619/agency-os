# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not apps/web — this is a workspace build and
# the image needs packages/core and packages/db too. See docker-compose.yml.

# --- deps: install once against the whole workspace ------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json   packages/db/
COPY apps/web/package.json      apps/web/
COPY apps/agent/package.json    apps/agent/
RUN npm ci

# --- build: compile the workspace packages, then Next ----------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules   ./packages/db/node_modules
COPY --from=deps /app/apps/web/node_modules      ./apps/web/node_modules
COPY . .
# packages/core and packages/db compile to dist/ and are consumed as JS.
RUN npx tsc --build
# Next needs the env vars to exist at build time only for typechecking; the
# real values are injected at run time.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @agency/web

# --- run: the standalone server, no node_modules install needed ------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# `output: standalone` with outputFileTracingRoot at the repo root emits a
# tree rooted at .next/standalone containing apps/web/server.js plus a pruned
# node_modules. Static assets are NOT included and must be copied separately.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
