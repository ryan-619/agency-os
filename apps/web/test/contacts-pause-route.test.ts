/**
 * PATCH /api/contacts/[id] pause and resume, and the ledger's buttons for
 * them, pinned by reading their source: the route imports `@/auth` and the
 * ledger `@/components`, so neither can be imported here (CLAUDE.md, "a
 * module a test imports carries no `server-only` and no `@/` import"). What
 * the two calls DO is tested against a real engine in
 * packages/db/test/contact-pause.test.ts; this file pins that the route goes
 * through them and says what they said.
 *
 * Two review findings (round 3):
 *
 *  - Resume lifted any pause, including the ones an opt-out nobody could
 *    record and an unfinished erasure leave — the only thing then standing
 *    between that person and a send.
 *  - Pause on somebody a reply had already paused changed nothing and
 *    answered `{paused: true}`; answering the reply then resumed them over
 *    the teammate's hold.
 *
 * And two from round 4:
 *
 *  - [20] Resume lifted whatever pause the ROUTE read after the click, not
 *    the one the page showed, so a teammate's hold written since the page
 *    loaded was lifted from a stale tab. Every Resume button now sends the
 *    `pausedReason` it rendered, and the route lifts that one and no other.
 *  - [12] The route wrote `contact.resumed` after the resume had committed,
 *    behind `.catch(() => {})`, and the re-pause guard reads that row. The
 *    row is now `contactResumeByHand`'s own, in the resume's transaction.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pauseReasonClass } from '@agency/core'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** The source without comments, so a sentence ABOUT a call does not count as one. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const route = code(read('../src/app/api/contacts/[id]/route.ts'))
const ledger = code(read('../src/components/contacts/ledger.tsx'))
/** Every component with a Resume button that calls the route. */
const RESUME_BUTTONS = [
  '../src/components/contacts/ledger.tsx',
  '../src/components/outreach/contacts.tsx',
  '../src/components/outreach/suppressions.tsx',
  '../src/components/inbox/queue.tsx',
] as const

const branch = (action: string): string => {
  const start = route.indexOf(`if (action === '${action}')`)
  expect(start).toBeGreaterThan(-1)
  const end = route.indexOf('\n  if (action ===', start + 1)
  return route.slice(start, end === -1 ? undefined : end)
}

describe('PATCH /api/contacts/[id]', () => {
  it('resumes only through contactResumeByHand, on the pause the PAGE showed, and answers a refusal with its sentence', () => {
    const resume = branch('resume')
    expect(resume).toMatch(
      /contactResumeByHand\(db, \{\s*orgId: user\.orgId, contact, expectedReason: pausedReason, actor: user\.id,?\s*\}\)/,
    )
    // Never the unconditional UPDATE, and never the reason the route read.
    expect(resume).not.toMatch(/resumeContact\(/)
    expect(resume).not.toMatch(/contact\.pausedReason/)
    // A body that names no pause is refused before anything is read as one.
    expect(resume.indexOf("typeof pausedReason !== 'string'")).toBeGreaterThan(-1)
    expect(resume.indexOf("typeof pausedReason !== 'string'")).toBeLessThan(resume.indexOf('contactResumeByHand('))
    expect(resume).toMatch(/status: 400/)
    expect(resume).toMatch(/r\.reason === 'not_found' \? 404 : 409/)
    expect(resume).toMatch(/error: r\.message/)
  })

  it('writes no `contact.resumed` row of its own: the resume writes it, in its own transaction', () => {
    expect(branch('resume')).not.toMatch(/appendAudit\(/)
    expect(route).not.toMatch(/action: 'contact\.resumed'/)
  })

  it('pauses only through contactPauseByHand, and never answers paused for a pause that did not happen', () => {
    const pause = branch('pause')
    expect(pause).toMatch(/contactPauseByHand\(db, \{/)
    expect(pause).not.toMatch(/\bpauseContact\(/)
    // A pause that stands is a 409 with its sentence; a missing contact a 404.
    expect(pause).toMatch(/status: r\.reason === 'not_found' \? 404 : 409/)
    expect(pause).toMatch(/error: r\.message/)
    expect(pause.indexOf('if (!r.ok)')).toBeGreaterThan(-1)
    expect(pause.indexOf('if (!r.ok)')).toBeLessThan(pause.indexOf("action: 'contact.paused'"))
    // `{ paused: true }` only after the refusal has been answered.
    expect(pause.indexOf('if (!r.ok)')).toBeLessThan(pause.indexOf('paused: true'))
  })
})

describe('every Resume button', () => {
  it('sends the pause it showed, so the route lifts that one and no other', () => {
    for (const path of RESUME_BUTTONS) {
      const src = code(read(path))
      const calls = src.match(/action: 'resume'[^}]*\}/g) ?? []
      expect(calls.length, path).toBeGreaterThan(0)
      for (const call of calls) expect(call, path).toMatch(/pausedReason: \w+(?:\.\w+)*\.pausedReason\b/)
    }
  })

  it('there is no Resume button the list above misses', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const root = fileURLToPath(new URL('../src', import.meta.url))
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(name) && /action: 'resume'/.test(code(readFileSync(full, 'utf8')))) {
          found.push(`../src${full.slice(root.length)}`)
        }
      }
    }
    walk(root)
    expect(found.sort()).toEqual([...RESUME_BUTTONS].sort())
  })
})

describe('the ledger', () => {
  it('reads the pause’s class with the one reader, and offers Resume only for a pause a person may lift', () => {
    expect(ledger).toMatch(/import \{ pauseReasonClass[^}]*\} from '@agency\/core'/)
    expect(ledger).toMatch(/pauseReasonClass\(r\.pausedReason\)/)
    // The two classes the route refuses are named where the button is decided.
    expect(ledger).toMatch(/'opt_out_not_recorded'/)
    expect(ledger).toMatch(/'erasure'/)
    expect(ledger).toMatch(/\/suppressions/)
  })

  it('offers Pause beside Resume for somebody a reply paused, so a teammate can hold them', () => {
    expect(ledger).toMatch(/pausedFor === 'replied'/)
  })

  it('the classes it reads are the ones the writers produce', () => {
    expect(pauseReasonClass('opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (Error)')).toBe(
      'opt_out_not_recorded',
    )
    expect(pauseReasonClass('erasure requested 2026-09-15; not completed (Error)')).toBe('erasure')
    expect(pauseReasonClass('replied 2026-09-15T12:00:00.000Z')).toBe('replied')
  })
})
