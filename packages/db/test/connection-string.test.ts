/**
 * `sslmode=require` spelled as the `verify-full` pg already treats it as
 * (2026-10-09): today's verification, kept through pg 9, and no SECURITY
 * WARNING at every start.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'pg-connection-string'
import { describe, expect, it } from 'vitest'
import { pgConnectionString } from '../src/connection-string.js'

const NEON = 'postgres://app:p%40ss%3Fword@ep-quiet-sun-123456-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

describe('pgConnectionString', () => {
  it('spells require, prefer and verify-ca as verify-full, and leaves the rest byte for byte', () => {
    expect(pgConnectionString(NEON)).toBe(NEON.replace('sslmode=require', 'sslmode=verify-full'))
    expect(pgConnectionString('postgres://u@h/db?sslmode=prefer')).toBe('postgres://u@h/db?sslmode=verify-full')
    expect(pgConnectionString('postgres://u@h/db?a=1&sslmode=verify-ca&b=2')).toBe('postgres://u@h/db?a=1&sslmode=verify-full&b=2')
  })

  it('leaves every other mode, no mode, and a string that asks for libpq semantics alone', () => {
    for (const url of [
      'postgres://agency:agency@127.0.0.1:5433/postgres',
      'postgres://u@h/db?sslmode=disable',
      'postgres://u@h/db?sslmode=no-verify',
      'postgres://u@h/db?sslmode=verify-full',
      'postgres://u@h/db?uselibpqcompat=true&sslmode=require',
      'postgres://u@h/db?notsslmode=require',
    ]) {
      expect(pgConnectionString(url), url).toBe(url)
    }
  })

  it('is what pg already does: the same TLS settings, without the warning', () => {
    const before = parse(NEON)
    const after = parse(pgConnectionString(NEON))
    expect(after.ssl).toEqual(before.ssl)
    expect({ ...after, sslmode: undefined }).toEqual({ ...before, sslmode: undefined })
  })

  it('is used wherever a process opens its database', () => {
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')
    expect(src('apps/web/src/lib/db.ts')).toMatch(/connectionString: pgConnectionString\(env\(\)\.DATABASE_URL\)/)
    expect(src('apps/agent/src/worker.ts')).toMatch(/const databaseUrl = pgConnectionString\(env\.DATABASE_URL\)/)
    expect(src('apps/voice/src/main.ts')).toMatch(/connectionString: pgConnectionString\(env\.DATABASE_URL\)/)
    expect(src('packages/db/src/cli.ts')).toMatch(/new Client\(\{ connectionString: pgConnectionString\(url\) \}\)/)
  })
})
