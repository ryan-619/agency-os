/**
 * /inbox's order, words and request bodies, without a database.
 *
 * The rule this file exists for: a person may set any kind EXCEPT
 * `opted_out`, and may never clear one. The query refuses it in its
 * predicate (`packages/db/test/inbox.test.ts`); this pins the route's half,
 * the zod enum, and the copy that tells a person why the choice is missing.
 */
import { describe, expect, it } from 'vitest'
import { REPLY_KINDS } from '@agency/core'
import type { Deployment } from '../src/lib/deployment-facts'
import {
  ANSWER_BODY_MAX, ANSWER_DRAFTED_NOTE, ANSWER_REFUSAL_STATUS, ANSWER_SUBJECT_MAX, HUMAN_REPLY_KINDS,
  INBOX_GROUP_LABELS, INBOX_GROUP_ORDER, INBOX_LEDE, OPTED_OUT_NOTE, RECLASSIFY_HINT,
  answerIsLive, answerSchema, answerStateWords, answerSubject, firstIssue, groupInbox, inboxActionSchema,
  inboxDeploymentNotes, inboxGroupOf, personName,
} from '../src/lib/inbox-view'

const BARE: Deployment = {
  worker: false, mailIsLocalSink: false, inbound: 'none', cron: false, slack: false, unsubscribe: false,
}

describe('the reading order', () => {
  it('is unclassified first, then interested, wrong person, not now, other, automatic, and opted out last', () => {
    expect(INBOX_GROUP_ORDER).toEqual([
      'unclassified', 'interested', 'wrong_person', 'not_now', 'other', 'auto_reply', 'opted_out',
    ])
  })

  it('covers every kind the classifier can store, exactly once', () => {
    const stored = INBOX_GROUP_ORDER.filter((g) => g !== 'unclassified')
    expect([...stored].sort()).toEqual([...REPLY_KINDS].sort())
    for (const g of INBOX_GROUP_ORDER) expect(INBOX_GROUP_LABELS[g]).toBeTruthy()
  })

  it('groups rows in that order, keeps their order inside a group, and leaves empty groups out', () => {
    const rows = [
      { id: 'a', kind: 'opted_out' },
      { id: 'b', kind: 'interested' },
      { id: 'c', kind: null },
      { id: 'd', kind: 'interested' },
      { id: 'e', kind: 'auto_reply' },
    ]
    const groups = groupInbox(rows, (r) => r.kind)
    expect(groups.map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ['unclassified', ['c']],
      ['interested', ['b', 'd']],
      ['auto_reply', ['e']],
      ['opted_out', ['a']],
    ])
    expect(groups[0]!.label).toBe('Not classified yet')
    expect(groupInbox([], () => null)).toEqual([])
  })

  it('shows a kind this build does not know as unread rather than guessing at one', () => {
    expect(inboxGroupOf(null)).toBe('unclassified')
    expect(inboxGroupOf('enthusiastic')).toBe('unclassified')
    expect(inboxGroupOf('not_now')).toBe('not_now')
  })
})

describe('reclassifying (§2.1: opted_out is the reader’s alone)', () => {
  it('offers the five kinds and never opted_out', () => {
    expect(HUMAN_REPLY_KINDS).toEqual(['interested', 'wrong_person', 'not_now', 'other', 'auto_reply'])
    expect(HUMAN_REPLY_KINDS).not.toContain('opted_out')
    expect([...HUMAN_REPLY_KINDS, 'opted_out'].sort()).toEqual([...REPLY_KINDS].sort())
  })

  it('accepts each of the five', () => {
    for (const kind of HUMAN_REPLY_KINDS) {
      expect(inboxActionSchema.safeParse({ action: 'reclassify', kind }).success).toBe(true)
    }
  })

  it('refuses opted_out with the sentence that says why', () => {
    const r = inboxActionSchema.safeParse({ action: 'reclassify', kind: 'opted_out' })
    expect(r.success).toBe(false)
    if (r.success) return
    expect(firstIssue(r.error)).toContain(RECLASSIFY_HINT)
  })

  it('refuses a missing kind, an unknown action and a non-object', () => {
    expect(inboxActionSchema.safeParse({ action: 'reclassify' }).success).toBe(false)
    const unknown = inboxActionSchema.safeParse({ action: 'delete' })
    expect(unknown.success).toBe(false)
    if (!unknown.success) expect(firstIssue(unknown.error)).toBe('action must be handled or reclassify')
    expect(inboxActionSchema.safeParse(null).success).toBe(false)
    expect(inboxActionSchema.safeParse({ action: 'handled' }).success).toBe(true)
  })

  it('tells a person the choice is missing on purpose', () => {
    expect(RECLASSIFY_HINT).toBe('an opt-out is decided by the person’s own words, never here.')
    expect(OPTED_OUT_NOTE).toBe('asked to stop — do not answer. The suppression row is what enforces it.')
  })
})

describe('an answer', () => {
  it('is bounded: a subject of 200 and a body of 4000, both required', () => {
    expect(ANSWER_SUBJECT_MAX).toBe(200)
    expect(ANSWER_BODY_MAX).toBe(4000)
    const ok = answerSchema.safeParse({ subject: ' Re: hello ', body: ' Thursday works. ' })
    expect(ok.success && ok.data).toEqual({ subject: 'Re: hello', body: 'Thursday works.' })

    expect(answerSchema.safeParse({ subject: 'x'.repeat(201), body: 'b' }).success).toBe(false)
    expect(answerSchema.safeParse({ subject: 's', body: 'x'.repeat(4001) }).success).toBe(false)
    expect(answerSchema.safeParse({ subject: '   ', body: 'b' }).success).toBe(false)
    expect(answerSchema.safeParse({ subject: 's', body: '' }).success).toBe(false)
  })

  it('takes a campaign only as an id', () => {
    const id = '5d0c1f6e-8f7a-4b61-9a51-3c2b1d0e9f8a'
    expect(answerSchema.safeParse({ subject: 's', body: 'b', campaignId: id }).success).toBe(true)
    expect(answerSchema.safeParse({ subject: 's', body: 'b', campaignId: null }).success).toBe(true)
    expect(answerSchema.safeParse({ subject: 's', body: 'b', campaignId: "1' OR '1'='1" }).success).toBe(false)
  })

  it('answers somebody who asked to stop with a 409, like every other state refusal', () => {
    expect(ANSWER_REFUSAL_STATUS.opted_out).toBe(409)
    expect(ANSWER_REFUSAL_STATUS.consent_refused).toBe(409)
    expect(ANSWER_REFUSAL_STATUS.already_queued).toBe(409)
    expect(ANSWER_REFUSAL_STATUS.not_found).toBe(404)
    expect(ANSWER_REFUSAL_STATUS.wrong_channel).toBe(400)
  })

  it('says it is a draft, who approves it, and that it threads', () => {
    expect(ANSWER_DRAFTED_NOTE).toBe(
      'This is a draft. A person approves it on /approvals and the worker sends it after re-checking every ' +
        'rule; it threads under their reply.',
    )
    expect(INBOX_LEDE).toContain('answering resumes them, and the answer is a draft a person approves')
  })

  it('prefixes Re: once, however many the thread collected', () => {
    expect(answerSubject('A gap on your security page')).toBe('Re: A gap on your security page')
    expect(answerSubject('Re: RE: Aw: A gap')).toBe('Re: A gap')
    expect(answerSubject(null)).toBe('Re: your reply')
    expect(answerSubject('x'.repeat(300))).toHaveLength(ANSWER_SUBJECT_MAX)
  })

  it('reads where the latest answer got to', () => {
    expect(answerStateWords('awaiting_approval')).toBe('an answer is waiting on /approvals')
    expect(answerStateWords('sent')).toBe('answered')
    expect(answerStateWords('refused')).toContain('not sent')
    expect(answerIsLive('awaiting_approval')).toBe(true)
    expect(answerIsLive('approved')).toBe(true)
    expect(answerIsLive('refused')).toBe(false)
    expect(answerIsLive('sent')).toBe(false)
  })
})

describe('what the deployment can honestly promise', () => {
  it('says nothing can read a reply when neither a worker nor a webhook exists', () => {
    const notes = inboxDeploymentNotes(BARE)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('nothing here can learn that somebody replied')
  })

  it('says only address matches are possible with a webhook and no worker', () => {
    const notes = inboxDeploymentNotes({ ...BARE, inbound: 'webhook' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('only replies from an address on exactly one contact can be matched here')
    expect(notes[0]).toContain('there is no Message-ID to match')
  })

  it('says nothing when a worker is reading the mailbox', () => {
    expect(inboxDeploymentNotes({ ...BARE, worker: true })).toEqual([])
    expect(inboxDeploymentNotes({ ...BARE, worker: true, inbound: 'webhook' })).toEqual([])
  })
})

describe('personName', () => {
  it('prefers a name, then an address, and never renders nothing', () => {
    expect(personName({ firstName: 'Priya', lastName: 'Shah', email: 'p@x.io' })).toBe('Priya Shah')
    expect(personName({ firstName: null, lastName: null, email: 'p@x.io' })).toBe('p@x.io')
    expect(personName({ firstName: null, lastName: null, email: null })).toBe('an unnamed contact')
    expect(personName(null)).toBe('a contact no longer in the CRM')
  })
})
