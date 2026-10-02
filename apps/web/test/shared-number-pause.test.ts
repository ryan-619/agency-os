/**
 * A shared number's holder on every screen with a Resume button (review
 * round 9, findings [3], [6] and [12]).
 *
 * A STOP texted from a number several contacts hold, which could not be
 * recorded, pauses every holder but the one it was filed under
 * `opt-out not recorded: a text from a number they share, <ISO> (<why>)`
 * (`sharedNumberOptOutReason`). `pauseReasonClass` reads it as
 * `opt_out_not_recorded`, and /contacts branched on the class alone: the
 * holder, who may have sent nothing, "asked to stop … the pause stays", and
 * no Resume — while `contactResumeByHand` lifts that pause once the number
 * is recorded, and its refusal and `check_send` send a person to /contacts
 * to lift it.
 *
 * The client reads the shape through `lib/shared-number-pause.ts`, a copy
 * of the database package's predicate (a client component must not import
 * `@agency/db`); this file holds the two to one answer. The components
 * import `@/`, so they are pinned by reading their source.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pauseReasonClass } from '@agency/core'
import {
  isSharedNumberOptOutPause as dbIsSharedNumberOptOutPause, sharedNumberHoldReason, sharedNumberOptOutReason,
} from '@agency/db/queries'
import {
  SHARED_NUMBER_HOLDER_NOTE, SHARED_NUMBER_HOLDER_WORDS, isSharedNumberOptOutPause, offersResume, resumeOfferFor,
} from '../src/lib/shared-number-pause'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** The source without comments, so a sentence ABOUT a call does not count as one. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const AT = new Date('2026-09-15T12:00:00.000Z')
const SHARED = sharedNumberOptOutReason(AT, 'record_failed')

/** Every pause a writer produces that could sit on a holder, and near-misses of the shape. */
const REASONS: readonly (string | null | undefined)[] = [
  SHARED,
  sharedNumberOptOutReason(AT, 'suppression_failed'),
  sharedNumberOptOutReason(new Date('2027-01-01T00:00:00.123Z'), 'record_failed'),
  'opt-out not recorded: a text from a number they share, 2026-09-15T12:00:00Z (record_failed)',
  // The asker's own unrecorded opt-out, and the other writers of the class.
  'opt-out not recorded: reply 2026-09-15T12:00:00.000Z (record_failed)',
  'opt-out not recorded: reply 2026-09-15T12:00:00.000Z (suppression_failed)',
  'opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (Error)',
  // The ordinary hold, a reply's pause, a teammate's, an erasure.
  sharedNumberHoldReason(AT),
  'replied 2026-09-15T12:00:00.000Z',
  'checking with legal (by owner@agency.test)',
  'erasure requested 2026-09-15; not completed (Error)',
  // Near-misses: trailing text, nested brackets, a prefix, another case, no time.
  `${SHARED} and more`,
  'opt-out not recorded: a text from a number they share, 2026-09-15T12:00:00.000Z (a (b))',
  'opt-out not recorded: a text from a number they share',
  'Opt-out not recorded: a text from a number they share, 2026-09-15T12:00:00.000Z (record_failed)',
  'opt-out not recorded: a text from a number they share, yesterday (record_failed)',
  ` ${SHARED}`,
  '',
  null,
  undefined,
]

describe('the client’s copy of the shared-number predicate', () => {
  it('answers exactly as packages/db’s does, over every reason above', () => {
    for (const reason of REASONS) {
      expect(isSharedNumberOptOutPause(reason), String(reason)).toBe(dbIsSharedNumberOptOutPause(reason))
    }
    // And the set is not vacuous: both answers occur.
    expect(REASONS.filter((r) => isSharedNumberOptOutPause(r))).toHaveLength(4)
  })

  it('carries the same pattern as sms.ts, character for character', () => {
    const pattern = /const SHARED_NUMBER_OPT_OUT = (\/.+\/)\n/
    const db = read('../../../packages/db/src/sms.ts').match(pattern)?.[1]
    const web = read('../src/lib/shared-number-pause.ts').match(pattern)?.[1]
    expect(db).toBeDefined()
    expect(web).toBe(db)
  })

  it('imports nothing, so a client component and this test can both take it', () => {
    const src = code(read('../src/lib/shared-number-pause.ts'))
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toContain('server-only')
    expect(src).not.toContain("'@/")
  })
})

describe('what a row offers for a pause', () => {
  const offer = (reason: string | null) => resumeOfferFor(reason === null ? null : pauseReasonClass(reason), reason)

  it('offers a shared number’s holder Resume, once the number is recorded', () => {
    expect(offer(SHARED)).toBe('record_number')
    expect(offer(sharedNumberOptOutReason(AT, 'suppression_failed'))).toBe('record_number')
    expect(offersResume('record_number')).toBe(true)
  })

  it('still offers no Resume for the contact’s own unrecorded opt-out, or an unfinished erasure', () => {
    expect(offer('opt-out not recorded: reply 2026-09-15T12:00:00.000Z (record_failed)')).toBe('opt_out_not_recorded')
    expect(offer('opt-out not recorded: one-click unsubscribe 2026-09-15T11:00:00.000Z (Error)')).toBe('opt_out_not_recorded')
    expect(offer('erasure requested 2026-09-15; not completed (Error)')).toBe('erasure')
    expect(offersResume('opt_out_not_recorded')).toBe(false)
    expect(offersResume('erasure')).toBe(false)
  })

  it('offers Resume for every other pause, and nothing for nobody paused', () => {
    for (const reason of [sharedNumberHoldReason(AT), 'replied 2026-09-15T12:00:00.000Z', 'checking (by a@b.test)']) {
      expect(offer(reason), reason).toBe('resume')
    }
    expect(offer(null)).toBeNull()
    expect(offersResume(null)).toBe(false)
  })
})

describe('what a holder is told', () => {
  it('never says they asked to stop, says they may not have, and names the fix the route checks for', () => {
    expect(SHARED_NUMBER_HOLDER_NOTE).toBe(
      'A text from a number they share asked to stop, and it could not be recorded — they may not have sent it. ' +
        'Record the number on /suppressions, then Resume; until the number is recorded there, Resume is refused.',
    )
    expect(SHARED_NUMBER_HOLDER_NOTE).not.toMatch(/they asked to stop|the pause stays|No Resume/)
    expect(SHARED_NUMBER_HOLDER_WORDS.link).toBe('/suppressions')
  })

  /** contactResumeByHand lifts it once a phone suppression matches the holder's number — the route's own check. */
  it('is right about what lifts it', () => {
    const inbox = read('../../../packages/db/src/inbox.ts')
    expect(inbox).toContain('isSharedNumberOptOutPause(contact.pausedReason)')
    expect(inbox).toContain("suppressionKeysFor(contact.phone, 'sms')")
  })

  it('is rendered with the suppression list as a link', () => {
    const note = code(read('../src/components/shared-number-note.tsx'))
    expect(note).toContain('{SHARED_NUMBER_HOLDER_WORDS.lead}')
    expect(note).toContain('<a href="/suppressions">{SHARED_NUMBER_HOLDER_WORDS.link}</a>')
    expect(note).toContain('{SHARED_NUMBER_HOLDER_WORDS.tail}')
  })
})

describe('every screen that renders the pause with a Resume button', () => {
  const ledger = code(read('../src/components/contacts/ledger.tsx'))

  it('/contacts decides the buttons through resumeOfferFor, and offers Resume for a holder', () => {
    expect(ledger).toMatch(/const offer = resumeOfferFor\(pausedFor, r\.pausedReason\)/)
    expect(ledger).toMatch(/offer === 'record_number' \? \(\s*<span className="muted" style=\{\{ fontSize: 12 \}\}>\s*<SharedNumberHolderNote \/>/)
    // One Resume button, rendered for the holder as for any pause a person may lift.
    expect(ledger).toMatch(/\{offersResume\(offer\) \? \(\s*<button[^>]*onClick=\{\(\) => void patch\(r\.id, \{ action: 'resume', pausedReason: r\.pausedReason \}\)\}>\s*Resume/)
    expect(ledger.match(/action: 'resume'/g)).toHaveLength(1)
    // The no-Resume line is the contact's own opt-out's alone now.
    expect(ledger).toMatch(/offer === 'opt_out_not_recorded' \? \(\s*<span[^>]*>\s*No Resume: they asked to stop/)
    expect(ledger).not.toMatch(/pausedFor === 'opt_out_not_recorded' \?/)
  })

  it.each([
    ['the company page’s People', '../src/components/outreach/contacts.tsx', 'c.pausedReason'],
    ['/suppressions’ paused list', '../src/components/outreach/suppressions.tsx', 'p.pausedReason'],
    ['/inbox', '../src/components/inbox/queue.tsx', 'row.contact.pausedReason'],
  ])('%s says what lifts a holder’s pause beside its Resume', (_where, path, reason) => {
    const src = code(read(path))
    expect(src).toContain("import { SharedNumberHolderNote } from '@/components/shared-number-note'")
    expect(src).toContain("import { isSharedNumberOptOutPause } from '@/lib/shared-number-pause'")
    expect(src).toMatch(new RegExp(`isSharedNumberOptOutPause\\(${reason.replace(/\./g, '\\.')}\\) \\? \\(\\s*<(div|span)[^>]*>\\s*<SharedNumberHolderNote />`))
    expect(src).toMatch(/action: 'resume'/)
  })
})
