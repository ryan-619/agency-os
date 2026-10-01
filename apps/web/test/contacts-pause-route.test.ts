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

const branch = (action: string): string => {
  const start = route.indexOf(`if (action === '${action}')`)
  expect(start).toBeGreaterThan(-1)
  const end = route.indexOf('\n  if (action ===', start + 1)
  return route.slice(start, end === -1 ? undefined : end)
}

describe('PATCH /api/contacts/[id]', () => {
  it('resumes only through contactResumeByHand, on the reason the page read, and answers a refusal with its sentence', () => {
    const resume = branch('resume')
    expect(resume).toMatch(/contactResumeByHand\(db, \{ orgId: user\.orgId, contact \}\)/)
    // Never the unconditional UPDATE any more.
    expect(resume).not.toMatch(/resumeContact\(/)
    expect(resume).toMatch(/status: 409/)
    expect(resume).toMatch(/r\.message/)
    // The audit row is written only for a resume that happened.
    expect(resume.indexOf('if (!r.ok)')).toBeGreaterThan(-1)
    expect(resume.indexOf('if (!r.ok)')).toBeLessThan(resume.indexOf("action: 'contact.resumed'"))
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
