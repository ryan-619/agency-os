#!/usr/bin/env node
/**
 * Apply pending migrations from INSIDE a Vercel production build, when — and
 * only when — the deploy asked for it with
 * `vercel deploy --prod --build-env AGENCY_MIGRATE_ON_BUILD=1`.
 *
 * Why here: the production database URL is a Sensitive variable on the Vercel
 * project, which `vercel pull` returns as a placeholder and no person or
 * assistant needs to hold (§2.3). A Vercel build sees the real value. Running
 * the migrator before `next build` keeps DEPLOYING.md's order — migrate
 * FIRST: a migration that fails fails the build, and nothing is deployed;
 * code is promoted only after the schema it reads is in place.
 *
 * Every other build — a preview, a git-connected build, `vercel build` in CI
 * — does nothing here and says so in one line. A request on anything but a
 * production build is refused, because a preview that migrated production
 * would be the mistake this guard exists for.
 *
 * The URL is never printed: the migration CLI prints `host:port/db` only
 * (`safeTarget`). An unpooled URL is preferred — Neon's Vercel integration
 * sets DATABASE_URL_UNPOOLED or POSTGRES_URL_NON_POOLING — else the pooled
 * DATABASE_URL with `-pooler` taken off the endpoint, Neon's direct host.
 */
import { spawnSync } from 'node:child_process'

const env = process.env

if (env.AGENCY_MIGRATE_ON_BUILD !== '1') {
  console.log('migrations: not requested for this build')
  process.exit(0)
}
if (env.VERCEL_ENV !== 'production') {
  console.error(`migrations: refused — requested on a ${env.VERCEL_ENV || 'non-Vercel'} build; only a production build may migrate`)
  process.exit(1)
}

function postgresUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    return /^postgres(ql)?:$/.test(url.protocol) ? url : null
  } catch {
    return null
  }
}

const candidates = [
  ['DATABASE_URL_UNPOOLED', env.DATABASE_URL_UNPOOLED],
  ['POSTGRES_URL_NON_POOLING', env.POSTGRES_URL_NON_POOLING],
  ['DATABASE_URL', env.DATABASE_URL],
]
let chosen = null
for (const [name, value] of candidates) {
  const url = postgresUrl(value)
  if (!url) continue
  let note = ''
  const [first, ...rest] = url.hostname.split('.')
  if (name === 'DATABASE_URL' && first.endsWith('-pooler')) {
    url.hostname = [first.slice(0, -'-pooler'.length), ...rest].join('.')
    note = ' (direct host: -pooler removed)'
  }
  chosen = { name, url: url.toString(), note }
  break
}
if (!chosen) {
  console.error('migrations: refused — no postgres:// URL in DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING or DATABASE_URL')
  process.exit(1)
}
console.log(`migrations: applying from ${chosen.name}${chosen.note}`)

function cli(...args) {
  const r = spawnSync(process.execPath, ['packages/db/dist/cli.js', ...args], {
    env: { ...env, DATABASE_URL: chosen.url },
    stdio: 'inherit',
  })
  return r.status ?? 1
}

const up = cli('up')
if (up !== 0) {
  console.error('migrations: FAILED — the build stops here, and nothing is deployed')
  process.exit(up)
}
process.exit(cli('status'))
