import { gunzipSync } from 'node:zlib'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RawCapture } from '../src/types.js'

export const FIXTURE_DIR = new URL('../fixtures/', import.meta.url).pathname
export const GOLDEN_PATH = join(FIXTURE_DIR, 'python-golden.json')

export interface Fixture extends RawCapture {
  readonly company?: string
}

export function fixtureNames(): string[] {
  if (!existsSync(FIXTURE_DIR)) return []
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json.gz'))
    .map((f) => f.replace(/\.json\.gz$/, ''))
    .sort()
}

export function loadFixture(domain: string): Fixture {
  const raw = gunzipSync(readFileSync(join(FIXTURE_DIR, `${domain}.json.gz`)))
  return JSON.parse(raw.toString('utf8')) as Fixture
}

/** Output of the original Python engine over the same fixtures. */
export interface Golden {
  readonly profile: {
    readonly domain: string
    readonly title: string
    readonly fetch_ok: boolean
    readonly fetch_error: string
    readonly has_login_surface: boolean
    readonly is_security_vendor: boolean
    readonly mentions_security_hiring: boolean
    readonly compliance_claims: string[]
    readonly outdated_libs: Array<{ lib: string; version: string; note: string; src?: string }>
    readonly observations: Record<string, { observed: boolean; gap: boolean | null; detail: string }>
  }
  readonly result: {
    readonly domain: string
    readonly company: string
    readonly score: number
    readonly tier: string
    readonly qualified: boolean
    readonly disqualified: string
    readonly gaps: Array<{ key: string; weight: number; why: string; detail: string }>
    readonly strengths: Array<{ key: string; detail: string }>
    readonly headline_finding: string
    readonly angle: string
    readonly evidence: Array<{ claim: string; observed: string }>
    readonly reachable: boolean
  }
}

export function loadGoldens(): Record<string, Golden> {
  if (!existsSync(GOLDEN_PATH)) return {}
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, Golden>
}
