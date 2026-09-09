# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT. See docker-compose.yml.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json   packages/db/
COPY apps/web/package.json      apps/web/
COPY apps/agent/package.json    apps/agent/
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules   ./packages/db/node_modules
COPY --from=deps /app/apps/agent/node_modules    ./apps/agent/node_modules
COPY . .
RUN npx tsc --build

# Drop devDependencies for the runtime image.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production AGENT_PORT=3001

RUN addgroup -g 1001 -S nodejs && adduser -S agent -u 1001

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json   packages/db/
COPY apps/web/package.json      apps/web/
COPY apps/agent/package.json    apps/agent/
RUN npm ci --omit=dev --workspace @agency/agent --include-workspace-root

COPY --from=build --chown=agent:nodejs /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=agent:nodejs /app/packages/db/dist   ./packages/db/dist
COPY --from=build --chown=agent:nodejs /app/apps/agent/dist    ./apps/agent/dist
# The migration CLI ships with the image so `docker compose run` can apply them.
COPY --chown=agent:nodejs packages/db/migrations ./packages/db/migrations
COPY --chown=agent:nodejs packages/db/seed       ./packages/db/seed

USER agent
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/agent/dist/index.js"]
