/**
 * The production build's migration step (tools/vercel-build-migrate.mjs).
 *
 * It runs inside EVERY Vercel build, through `build:vercel`, so the guard is
 * the whole point: nothing happens unless a production deploy asked for it,
 * a request on any other build is refused, and the database URL — a
 * credential — is never printed, whatever path the script takes.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = resolve(root, 'tools/vercel-build-migrate.mjs')
const PASSWORD = 'pw-never-printed-4729'

function run(env: Record<string, string>) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(AGENCY_MIGRATE_ON_BUILD|VERCEL_ENV|DATABASE_URL|DATABASE_URL_UNPOOLED|POSTGRES_URL_NON_POOLING)$/.test(k),
    ),
  )
  const r = spawnSync(process.execPath, [script], { cwd: root, env: { ...clean, ...env }, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('the build-time migration step', () => {
  it('does nothing on a build that did not ask', () => {
    const r = run({ VERCEL_ENV: 'production', DATABASE_URL: `postgres://u:${PASSWORD}@127.0.0.1:1/db` })
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/not requested/)
  })

  it('refuses a request on a preview build, so a preview can never migrate production', () => {
    const r = run({ AGENCY_MIGRATE_ON_BUILD: '1', VERCEL_ENV: 'preview', DATABASE_URL: `postgres://u:${PASSWORD}@127.0.0.1:1/db` })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/refused/)
  })

  it('refuses when the URL is the placeholder a Sensitive variable reads as outside Vercel', () => {
    const r = run({ AGENCY_MIGRATE_ON_BUILD: '1', VERCEL_ENV: 'production', DATABASE_URL: '[sensitive]' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/no postgres:\/\/ URL/)
  })

  it('fails the build when the migration cannot run, and never prints the URL', () => {
    const r = run({
      AGENCY_MIGRATE_ON_BUILD: '1',
      VERCEL_ENV: 'production',
      DATABASE_URL: `postgres://u:${PASSWORD}@127.0.0.1:1/db`,
    })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/FAILED — the build stops here/)
    expect(r.out).not.toContain(PASSWORD)
  })

  it('prefers an unpooled URL, and takes -pooler off a pooled one', () => {
    const unpooled = run({
      AGENCY_MIGRATE_ON_BUILD: '1',
      VERCEL_ENV: 'production',
      DATABASE_URL_UNPOOLED: `postgres://u:${PASSWORD}@127.0.0.1:1/db`,
      DATABASE_URL: `postgres://u:${PASSWORD}@ep-a-pooler.example.invalid/db`,
    })
    expect(unpooled.out).toMatch(/applying from DATABASE_URL_UNPOOLED/)
    const pooled = run({
      AGENCY_MIGRATE_ON_BUILD: '1',
      VERCEL_ENV: 'production',
      DATABASE_URL: `postgres://u:${PASSWORD}@ep-a-pooler.example.invalid/db`,
    })
    expect(pooled.out).toMatch(/applying from DATABASE_URL \(direct host: -pooler removed\)/)
    expect(pooled.out).not.toContain(PASSWORD)
  })

  it('runs before next build in the build Vercel runs', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['build:vercel']).toBe('tsc --build && node tools/vercel-build-migrate.mjs && next build apps/web')
  })
})
