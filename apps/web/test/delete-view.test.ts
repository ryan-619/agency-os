/**
 * Delete, as a browser sees it (2026-10-15) — `lib/delete-view.ts`: which
 * rows get a Delete button, what the confirm says before anything is sent,
 * what a refusal reads as, what the pop-up says after, and how a bulk
 * delete's answer is read back row by row.
 *
 * The failures these guard against: a button offered on a record the
 * writer will always keep (a won deal, a sent quote, a LinkedIn step) — a
 * click that can only end in a refusal; a pop-up that carries a person's
 * address or name past the page, in session storage; and a bulk answer read
 * so loosely that a row the database KEPT is shown as deleted.
 *
 * The writers' own rules are tested against a real engine in
 * packages/db/test/deletes.test.ts; the routes' calls in
 * delete-routes.test.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noSiteDomain } from '@agency/core'
import {
  BULK_MAX, COMPANY_DELETE_GOES, COMPANY_DELETE_KEEPS, CONFIRM_WORDS, DELETED_WORDS, ICP_KEPT_WORDS,
  bulkConfirmMatches, bulkKeptGroups, bulkResultsFrom, bulkSummary, companiesBulkWords, companyConfirmMatches,
  companyConfirmWord, deleteFailureFrom, icpDeleteOffer, mayDeleteDeal, mayDeleteMeeting, mayDeleteProposal,
  mayDeleteQuote, mayDeleteTask, sendDelete, type DeleteKind,
} from '../src/lib/delete-view'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** An address, a phone number or a URL: none belongs in a pop-up. */
const PERSONAL = /@|\+?\d[\d\s-]{6,}\d|https?:\/\//

describe('which rows get a Delete button', () => {
  it('never offers one on a won deal — moving it off Won is the act', () => {
    for (const stage of ['new', 'contacted', 'replied', 'meeting', 'proposal', 'lost']) expect(mayDeleteDeal(stage), stage).toBe(true)
    expect(mayDeleteDeal('won')).toBe(false)
  })

  it('offers one on a meeting only while no outcome is recorded, cancelled or not', () => {
    expect(mayDeleteMeeting(null)).toBe(true)
    for (const outcome of ['held', 'no_show', 'rescheduled']) expect(mayDeleteMeeting(outcome), outcome).toBe(false)
    // A reschedule's replacement: the original points at it, so it is cancelled instead (review, 2026-10-15).
    expect(mayDeleteMeeting(null, true)).toBe(false)
    expect(mayDeleteMeeting(null, false)).toBe(true)
  })

  it('offers one on a draft proposal or quote and nothing past draft', () => {
    expect(mayDeleteProposal('draft')).toBe(true)
    for (const s of ['sent', 'accepted', 'declined', 'withdrawn']) expect(mayDeleteProposal(s), s).toBe(false)
    expect(mayDeleteQuote('draft')).toBe(true)
    for (const s of ['sent', 'accepted', 'declined', 'withdrawn']) expect(mayDeleteQuote(s), s).toBe(false)
    // Sent, then revised back to a draft: a buyer holds its number (review, 2026-10-15).
    expect(mayDeleteQuote('draft', true)).toBe(false)
    expect(mayDeleteQuote('draft', false)).toBe(true)
  })

  it('never offers one on a LinkedIn step or a done call that recorded "asked not to be called"', () => {
    expect(mayDeleteTask({ kind: 'todo', doneAt: null })).toBe(true)
    expect(mayDeleteTask({ kind: 'call', doneAt: '2026-10-01T10:00:00Z', outcome: 'reached' })).toBe(true)
    expect(mayDeleteTask({ kind: 'linkedin_send', doneAt: null })).toBe(false)
    expect(mayDeleteTask({ kind: 'linkedin_send', doneAt: '2026-10-01T10:00:00Z' })).toBe(false)
    expect(mayDeleteTask({ kind: 'call', doneAt: '2026-10-01T10:00:00Z', outcome: 'asked_to_stop' })).toBe(false)
    // Open, it records nothing yet.
    expect(mayDeleteTask({ kind: 'call', doneAt: null, outcome: null })).toBe(true)
  })

  it('offers an ICP profile only when it is inactive and scored nothing, and says why otherwise', () => {
    expect(icpDeleteOffer({ active: false, scores: 0 })).toBe('delete')
    expect(icpDeleteOffer({ active: true, scores: 0 })).toBe('active')
    expect(icpDeleteOffer({ active: false, scores: 3 })).toBe('scored')
    expect(icpDeleteOffer({ active: true, scores: 3 })).toBe('active')
    expect(ICP_KEPT_WORDS.active).toContain('Activate another profile first')
    expect(ICP_KEPT_WORDS.scored).toContain('scores were computed under it')
  })
})

describe('what the pop-up says once it is done', () => {
  it('names the kind of record, never the record — no address, number or link', () => {
    const kinds: DeleteKind[] = ['contact', 'company', 'deal', 'meeting', 'proposal', 'quote', 'task', 'campaign', 'template', 'icp']
    for (const k of kinds) {
      expect(DELETED_WORDS[k], k).toMatch(/^[A-Z][^.]*\./)
      expect(DELETED_WORDS[k], k).not.toMatch(PERSONAL)
    }
  })

  it('says the deal did not move back when a meeting goes, and that the company stays when a deal goes', () => {
    expect(DELETED_WORDS.meeting).toBe('Meeting deleted. The deal did not move back.')
    expect(DELETED_WORDS.deal).toBe('Deal deleted. The company and its meetings stay.')
  })

  it('counts a bulk answer, and never names anybody in the pop-up', () => {
    const noun = { one: 'person', many: 'people' }
    expect(bulkSummary([{ id: 'a', ok: true }, { id: 'b', ok: true }], noun)).toBe('2 people deleted.')
    expect(bulkSummary([{ id: 'a', ok: false, code: 'must_erase' }], noun)).toBe('Nothing deleted: 1 person kept.')
    expect(bulkSummary([{ id: 'a', ok: true }, { id: 'b', ok: false }, { id: 'c', ok: false }], noun)).toBe(
      '1 person deleted; 2 kept.',
    )
  })
})

describe('what the confirm says before anything is sent', () => {
  it('says what goes with a contact, and that anybody written to is erased instead', () => {
    const words = CONFIRM_WORDS.contact('Alex Chen')
    expect(words).toMatch(/^Delete Alex Chen\?/)
    expect(words).toContain('drafts waiting for them')
    expect(words).toContain('erases them instead')
    expect(words).toContain('suppression list')
  })

  it('says a deleted deal leaves its company, and a deleted meeting leaves the deal where it is', () => {
    expect(CONFIRM_WORDS.deal('Rentman')).toContain('The company, its meetings, proposals and tasks stay')
    expect(CONFIRM_WORDS.meeting).toContain('the deal does not move back')
    expect(CONFIRM_WORDS.meeting).toContain('Nobody is told')
  })

  it('names the act that applies instead, wherever there is one', () => {
    expect(CONFIRM_WORDS.proposal).toContain('withdrawn instead')
    expect(CONFIRM_WORDS.quote).toContain('withdrawn instead')
    expect(CONFIRM_WORDS.quote).toContain('may take its number')
    // A draft's Print/PDF shows its number too (review, 2026-10-15).
    expect(CONFIRM_WORDS.quote).toContain('if its Print/PDF went to a buyer, mark it sent and withdraw it instead')
    expect(CONFIRM_WORDS.campaign('Q4 dentists')).toContain('set it to done instead')
    expect(CONFIRM_WORDS.template('1107160000000012345')).toContain('switch it off instead')
    expect(CONFIRM_WORDS.task).toContain('ticked Done instead')
  })

  it('says, before a bulk delete, that a person written to is kept and the answer says why', () => {
    expect(CONFIRM_WORDS.contacts(1)).toMatch(/^Delete this person\?/)
    expect(CONFIRM_WORDS.contacts(3)).toMatch(/^Delete these 3 people\?/)
    expect(CONFIRM_WORDS.contacts(3)).toContain('is kept')
    expect(companiesBulkWords(4)).toMatch(/^Deletes these 4 companies/)
    expect(companiesBulkWords(4)).toContain('It cannot be undone.')
  })

  it('says, on the company page, what goes and what keeps a company before the button', () => {
    expect(COMPANY_DELETE_GOES.join(' ')).toContain('stops opening')
    for (const kept of ['a won deal', 'a meeting with its outcome recorded']) {
      expect(COMPANY_DELETE_KEEPS).toContain(kept)
    }
    // What the writer keeps since review, 2026-10-15, said before the button is pressed.
    expect(COMPANY_DELETE_KEEPS.join(' ')).toMatch(/a call on \/tasks where they asked to stop/)
    expect(COMPANY_DELETE_KEEPS.join(' ')).toMatch(/a quote sent once and revised back to a draft included/)
    // A shared number's holder is not told to be erased: recording the number is the way out.
    expect(COMPANY_DELETE_KEEPS).toContain('a person there who said no, or whose own opt-out could not be recorded — an owner erases them first')
    expect(COMPANY_DELETE_KEEPS).toContain('a person there holding a number a text asked to stop from, until the number is recorded on /suppressions')
  })
})

describe('deleting a company: the name typed back', () => {
  const rentman = { domain: 'rentman.io', name: 'Rentman' }

  it('asks for the domain, and takes it in any case with spaces around it', () => {
    expect(companyConfirmWord(rentman)).toBe('rentman.io')
    expect(companyConfirmMatches('rentman.io', rentman)).toBe(true)
    expect(companyConfirmMatches('  RENTMAN.io ', rentman)).toBe(true)
    expect(companyConfirmMatches('rentman', rentman)).toBe(false)
    expect(companyConfirmMatches('Rentman', rentman)).toBe(false)
    expect(companyConfirmMatches('', rentman)).toBe(false)
    expect(companyConfirmMatches(undefined, rentman)).toBe(false)
    expect(companyConfirmMatches(['rentman.io'], rentman)).toBe(false)
  })

  it('asks for a no-website business’s name, never its placeholder — the placeholder is core’s own', () => {
    const cafe = { domain: noSiteDomain('Yummy Bites', 'ChIJyummy'), name: 'Yummy  Bites ' }
    expect(companyConfirmWord(cafe)).toBe('Yummy Bites')
    expect(companyConfirmMatches('yummy bites', cafe)).toBe(true)
    expect(companyConfirmMatches(cafe.domain, cafe)).toBe(false)
    // With no name on record the placeholder is all there is to type.
    expect(companyConfirmWord({ domain: cafe.domain, name: null })).toBe(cafe.domain)
  })
})

describe('a bulk delete, row by row', () => {
  it('takes the count typed as digits and nothing else', () => {
    expect(bulkConfirmMatches('3', 3)).toBe(true)
    expect(bulkConfirmMatches(' 3 ', 3)).toBe(true)
    expect(bulkConfirmMatches('three', 3)).toBe(false)
    expect(bulkConfirmMatches('03x', 3)).toBe(false)
    expect(bulkConfirmMatches('4', 3)).toBe(false)
    expect(bulkConfirmMatches('0', 0)).toBe(false)
    expect(bulkConfirmMatches(3, 3)).toBe(false)
  })

  it('reads a malformed row as one that was NOT deleted, and drops a row with no id', () => {
    expect(
      bulkResultsFrom({
        results: [
          { id: 'a', ok: true },
          { id: 'b', ok: 'yes' },
          { id: 'c', ok: false, code: 'must_erase', message: 'Kept.' },
          { ok: true },
          null,
        ],
      }),
    ).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: false },
      { id: 'c', ok: false, code: 'must_erase', message: 'Kept.' },
    ])
    expect(bulkResultsFrom(null)).toEqual([])
    expect(bulkResultsFrom({ results: 'nope' })).toEqual([])
  })

  it('groups the kept rows by the writer’s sentence, with the names under each', () => {
    const labels = new Map([['a', 'Alex Chen'], ['b', 'Bala'], ['c', 'Akash']])
    const groups = bulkKeptGroups(
      [
        { id: 'a', ok: false, message: 'Something went out to this contact.' },
        { id: 'b', ok: true },
        { id: 'c', ok: false, message: 'Something went out to this contact.' },
        { id: 'd', ok: false },
      ],
      (id) => labels.get(id) ?? id,
    )
    expect(groups).toEqual([
      { message: 'Something went out to this contact.', labels: ['Alex Chen', 'Akash'] },
      { message: 'Not deleted.', labels: ['d'] },
    ])
  })

  it('holds the bar to the routes’ own limits', () => {
    expect(BULK_MAX).toEqual({ companies: 50, contacts: 100 })
    // The routes read the same constant rather than restating it.
    expect(read('../src/app/api/companies/delete/route.ts')).toContain('max: BULK_MAX.companies')
    expect(read('../src/app/api/contacts/delete/route.ts')).toContain('max: BULK_MAX.contacts')
  })
})

describe('what a refusal reads as', () => {
  it('shows the writer’s sentence for a refusal and a gone record', () => {
    expect(deleteFailureFrom(409, { error: 'must_erase', message: 'Something went out to this contact.' })).toEqual({
      code: 'must_erase',
      message: 'Something went out to this contact.',
    })
    expect(deleteFailureFrom(404, { error: 'not_found', message: 'No such deal — it may already have been deleted.' }).message).toBe(
      'No such deal — it may already have been deleted.',
    )
  })

  it('words the statuses a route answers with a code alone', () => {
    expect(deleteFailureFrom(401, { error: 'unauthorized' })).toEqual({
      code: 'unauthorized',
      message: 'You are signed out. Sign in again; nothing was deleted.',
    })
    expect(deleteFailureFrom(403, { error: 'forbidden' }, 'company').message).toBe(
      'Your role cannot delete this company. Nothing was deleted.',
    )
    expect(deleteFailureFrom(404, null).message).toContain('may already have been deleted')
    expect(deleteFailureFrom(502, 'not json')).toEqual({ code: 'http_502', message: 'That did not work, and nothing was deleted. Try again.' })
  })

  it('keeps a sentence an older route put in `error`, and never a code longer than a code', () => {
    expect(deleteFailureFrom(400, { error: 'That request could not be read.' })).toEqual({
      code: 'http_400',
      message: 'That request could not be read.',
    })
    expect(deleteFailureFrom(409, { error: 'x'.repeat(80), message: 'Kept.' }).code).toBe('http_409')
  })
})

describe('sendDelete', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends DELETE with no body by default, and reads a success', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ deleted: true, companyId: 'c' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await sendDelete('/api/deals/1')).toEqual({ ok: true, body: { deleted: true, companyId: 'c' } })
    expect(fetch).toHaveBeenCalledWith('/api/deals/1', { method: 'DELETE' })
  })

  it('sends a bulk list as JSON by POST, and reads a refusal as the writer’s sentence', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'confirm', message: 'Type 2.' }), { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const r = await sendDelete('/api/companies/delete', { method: 'POST', body: { ids: ['a', 'b'], confirm: '3' } })
    expect(r).toEqual({ ok: false, failure: { code: 'confirm', message: 'Type 2.' } })
    expect(fetch).toHaveBeenCalledWith('/api/companies/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['a', 'b'], confirm: '3' }),
    })
  })

  it('says to reload and look before trying again when the request never completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const r = await sendDelete('/api/tasks/1', { kind: 'task' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure.code).toBe('unreachable')
      expect(r.failure.message).toContain('Reload the page to see whether it is still there')
    }
  })
})

describe('the delete helpers stay importable here', () => {
  it.each(['../src/lib/delete-view.ts', '../src/lib/delete-answer.ts'])('%s carries no server-only and no @/ import', (file) => {
    const src = read(file)
    expect(src).not.toMatch(/from '@\//)
    expect(src).not.toMatch(/'server-only'/)
  })
})
