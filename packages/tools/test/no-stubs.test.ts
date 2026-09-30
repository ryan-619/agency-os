/**
 * No stub survives the build (§12, §13).
 *
 * Wave 1 created a module for every later feature to fill: a file whose
 * header read `// STUB — filled in wave N by <feature>`, and — for the
 * agent's tools — a handler answering `invalid_state` with "This tool is
 * not available in this revision." Every one of them compiled, passed its
 * barrel test, and did nothing. That is the danger: a stub that outlives
 * its wave is not a failing test, it is a feature that silently is not
 * there, and a tool the model is told about that always says no teaches it
 * a false shape of the business.
 *
 * So the markers are banned from shipped source. The scan is wider than the
 * places wave 1 put stubs — every `src/` under `apps/` and `packages/` —
 * because a marker copied into a new file is the same defect wherever it
 * lands. Tests are not scanned: they name the markers in order to look for
 * them, as this one does.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

/** The header every wave-1 stub carried, and the words every stub tool answered with. */
const MARKERS: readonly RegExp[] = [
  /\/\/\s*STUB\b/,
  /STUB — filled in wave/,
  /not available in this revision/i,
]

function stubMarkersIn(source: string): string[] {
  return MARKERS.filter((m) => m.test(source)).map(String)
}

function shippedSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
    }
  }
  for (const top of ['apps', 'packages']) {
    for (const d of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      try {
        walk(join(root, top, d.name, 'src'))
      } catch {
        // a workspace with no src/ ships no source
      }
    }
  }
  return out
}

describe('no wave stub survives in shipped source', () => {
  const files = shippedSources()
  const rel = (f: string): string => relative(root, f).split('\\').join('/')

  it('reads every place wave 1 put a stub, and more', () => {
    const scanned = files.map(rel)
    // The brief's four places, each proved present rather than assumed.
    for (const prefix of ['packages/tools/src/', 'packages/db/src/', 'packages/core/src/', 'apps/agent/src/']) {
      expect(scanned.some((f) => f.startsWith(prefix) && f.endsWith('.ts')), prefix).toBe(true)
    }
    expect(scanned.some((f) => f.startsWith('apps/web/src/components/') && f.endsWith('.tsx'))).toBe(true)
    // Specific files that WERE stubs, so a moved tree cannot make this pass by reading nothing.
    for (const f of [
      'packages/tools/src/replies.ts',
      'packages/db/src/contacts-ledger.ts',
      'apps/agent/src/boot/heartbeat.ts',
      'apps/agent/src/outreach/options.ts',
      'apps/web/src/components/search-box.tsx',
    ]) {
      expect(scanned, f).toContain(f)
    }
    expect(files.length).toBeGreaterThan(200)
  })

  it('can fail: each marker is caught in the shape wave 1 wrote it', () => {
    expect(stubMarkersIn('// STUB — filled in wave 2 by global-search\nexport {}')).not.toEqual([])
    expect(stubMarkersIn("const NOT_YET = 'This tool is not available in this revision.'")).not.toEqual([])
    expect(stubMarkersIn('export const x = 1 // a STUBBORN comment is not a stub')).toEqual([])
  })

  it('finds none of them', () => {
    const survivors = files.flatMap((f) => {
      const found = stubMarkersIn(readFileSync(f, 'utf8'))
      return found.length ? [`${rel(f)}: ${found.join(', ')}`] : []
    })
    expect(survivors).toEqual([])
  })
})
