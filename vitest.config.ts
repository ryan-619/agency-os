import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One suite across the whole monorepo. Domain tests (packages/core) are
    // pure and instant; database tests (packages/db) run against PGlite, an
    // embedded Postgres, so `npm test` needs no Docker and no server.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // PGlite spins up a WASM Postgres per suite; the default 5s is tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
