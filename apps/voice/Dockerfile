# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT. See docker-compose.yml.
#
# Mirrors apps/agent/Dockerfile, including the two mistakes that image
# documents (CLAUDE.md §4): every workspace package.json must be COPIED in
# the install stage, and the workspace must be DECLARED as a dependency of
# what the image runs. `npm ci` exits 0 on either mistake and the container
# dies later with ERR_MODULE_NOT_FOUND, with nothing red in the build.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/scanner/package.json packages/scanner/
COPY packages/tools/package.json   packages/tools/
COPY apps/web/package.json         apps/web/
COPY apps/agent/package.json       apps/agent/
COPY apps/voice/package.json       apps/voice/
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc --build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production VOICE_PORT=3003

RUN addgroup -g 1001 -S nodejs && adduser -S voice -u 1001

COPY package.json package-lock.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/scanner/package.json packages/scanner/
COPY packages/tools/package.json   packages/tools/
COPY apps/web/package.json         apps/web/
COPY apps/agent/package.json       apps/agent/
COPY apps/voice/package.json       apps/voice/
RUN npm ci --omit=dev --workspace @agency/voice --include-workspace-root

COPY --from=build --chown=voice:nodejs /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=voice:nodejs /app/packages/db/dist   ./packages/db/dist
COPY --from=build --chown=voice:nodejs /app/apps/voice/dist    ./apps/voice/dist

USER voice
EXPOSE 3003

# /readyz, not /livez: a process that is running but cannot reach the
# database will answer a liveness probe cheerfully while dropping calls.
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3003/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/voice/dist/index.js"]
