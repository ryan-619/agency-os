/**
 * The Vercel configuration, read back.
 *
 * The live deployment builds through three keys in `vercel.json`:
 * `buildCommand` (the packages must be compiled before `next build`, and
 * the app is not at the repo root), `outputDirectory` and `framework`. Lose
 * any of them and Vercel runs a default `next build` at the root, where
 * there is no Next app — and nothing in CI would notice, because CI builds
 * the app itself. The crons were added beside them, so this pins that the
 * three are still what they were, byte for byte, and that the schedule is
 * exactly the two daily jobs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as Record<string, unknown>

describe('vercel.json', () => {
  it('still builds the way the live deployment does', () => {
    expect(config['$schema']).toBe('https://openapi.vercel.sh/vercel.json')
    expect(config['buildCommand']).toBe('npm run build:vercel')
    expect(config['outputDirectory']).toBe('apps/web/.next')
    expect(config['framework']).toBe('nextjs')
  })

  it('schedules exactly the two daily jobs', () => {
    const crons = config['crons'] as { path: string; schedule: string }[]
    expect(crons.map((c) => c.path)).toEqual(['/api/cron/rescan', '/api/cron/digest'])
    // Once a day each, at a minute off the hour — Hobby jitters by up to an
    // hour either way, so a job at :00 would land anywhere from :00 to 01:00.
    for (const c of crons) expect(c.schedule).toMatch(/^[1-5]?\d \d{1,2} \* \* \*$/)
  })

  it('carries nothing else, so a key nobody reviewed cannot ride in', () => {
    expect(Object.keys(config).sort()).toEqual(['$schema', 'buildCommand', 'crons', 'framework', 'outputDirectory'])
  })
})
