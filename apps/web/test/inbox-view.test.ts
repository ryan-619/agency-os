/**
 * /inbox's order, words and request bodies, without a database.
 *
 * The rule this file exists for: a person may set any kind EXCEPT
 * `opted_out`, and may never clear one. The query refuses it in its
 * predicate (`packages/db/test/inbox.test.ts`); this pins the route's half,
 * the zod enum, and the copy that tells a person why the choice is missing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPLY_KINDS } from '@agency/core'
import type { Deployment } from '../src/lib/deployment-facts'
import {
  ANSWER_BODY_MAX, ANSWER_DRAFTED_NOTE, ANSWER_REFUSAL_STATUS, ANSWER_SUBJECT_MAX, HUMAN_REPLY_KINDS,
  INBOX_GROUP_LABELS, INBOX_GROUP_ORDER, INBOX_LEDE, OPTED_OUT_NOTE, RECLASSIFY_HINT,
  answerIsLive, answerSchema, answerStateWords, answerSubject, firstIssue, groupInbox, inboxActionSchema,
  inboxDeploymentNotes, inboxGroupOf, personName,
} from '../src/lib/inbox-view'
import { optedOutNote, optedOutWarning } from '../src/components/inbox/opted-out'
import { answerComposerNote, colleagueHeadline, resumedLine } from '../src/components/inbox/sender'

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

/**
 * Review round 8, [8]. A colleague on the thread replied all "please remove
 * me", and the reply was filed under the contact our message went to. The
 * row read "Priya Shah asked to stop — do not answer", and its warning told
 * a person to add a suppression for "this person" — which suppressing
 * PRIYA's address satisfied, while the sender stayed unrecorded.
 */
describe('a reply that asked to stop, and whose it was', () => {
  const own = { fromIsContact: true, from: 'priya@rentman.io', contactName: 'Priya Shah', suppressed: true }
  const colleague = { fromIsContact: false, from: 'sam@rentman.io', contactName: 'Priya Shah', suppressed: true }

  it('words the contact’s own stop exactly as before', () => {
    expect(optedOutNote(own)).toBe(`Priya Shah ${OPTED_OUT_NOTE}`)
    expect(optedOutWarning(own)).toBeNull()
    expect(optedOutWarning({ ...own, suppressed: false })).toBe(
      'This reply asked to stop, but no suppression row matches this person. Add one on the suppressions page — ' +
        'until then nothing but the pause stands between them and the next message.',
    )
    expect(optedOutNote({ ...own, contactName: null })).toBe(`This person ${OPTED_OUT_NOTE}`)
  })

  it('never says the contact asked to stop when somebody else on the thread did', () => {
    const note = optedOutNote(colleague)
    expect(note).not.toContain('Priya Shah asked to stop')
    expect(note).toBe(
      'A reply from another address on this thread (sam@rentman.io) asked to stop — do not answer it. Priya Shah did ' +
        'not ask, and is not treated as the one who asked; the address on the suppression list must be the one the ' +
        'reply came from.',
    )
    expect(optedOutWarning(colleague)).toBeNull()
  })

  it('sends a person to record the sender’s address, never the contact’s', () => {
    const warning = optedOutWarning({ ...colleague, suppressed: false })
    expect(warning).toBe(
      'This reply asked to stop, but no suppression row matches the address it came from (sam@rentman.io), which is ' +
        'not Priya Shah’s. Record THAT address on the suppressions page — never Priya Shah’s: recording theirs does ' +
        'not record this opt-out. Until it is recorded, Priya Shah cannot be resumed or answered.',
    )
    expect(warning).not.toContain('matches this person')
  })

  it('is fed by the page from the row, never worked out on the client', () => {
    const page = readFileSync(fileURLToPath(new URL('../src/app/inbox/page.tsx', import.meta.url)), 'utf8')
    expect(page).toContain('fromIsContact: r.fromIsContact')
    const queue = readFileSync(fileURLToPath(new URL('../src/components/inbox/queue.tsx', import.meta.url)), 'utf8')
    expect(queue).toContain('optedOutNote(stopOf(row))')
    expect(queue).toContain('optedOutWarning(stopOf(row))')
    expect(queue).not.toContain('OPTED_OUT_NOTE')
  })
})

/**
 * Review round 9 [13]: a colleague's reply that is not a stop was headlined
 * under the contact's name ("Priya Shah <sam@rentman.io>"), and the composer
 * said "Drafting resumes Priya Shah: their reply paused them" — while it was
 * Sam's reply that paused Priya, and the answer is addressed to Priya's
 * address on file, not to Sam. The Slack notice already said "from somebody
 * else on the thread".
 */
describe('a reply from somebody else on the thread', () => {
  const own = { fromIsContact: true, from: 'priya@rentman.io', contactName: 'Priya Shah', contactEmail: 'priya@rentman.io' }
  const colleague = { fromIsContact: false, from: 'sam@rentman.io', contactName: 'Priya Shah', contactEmail: 'priya@rentman.io' }
  const queue = readFileSync(fileURLToPath(new URL('../src/components/inbox/queue.tsx', import.meta.url)), 'utf8')
    .replace(/\s+/g, ' ')

  it('is headlined under its sender, filed under the contact', () => {
    expect(colleagueHeadline(colleague)).toEqual({
      sender: 'sam@rentman.io',
      note: 'another address on this thread, filed under Priya Shah',
    })
    expect(colleagueHeadline({ ...colleague, contactName: null })?.note).toBe(
      'another address on this thread, filed under a contact no longer in the CRM',
    )
  })

  it('leaves the contact’s own reply headlined as before', () => {
    expect(colleagueHeadline(own)).toBeNull()
    // No sender to headline: nothing to say about whose it was.
    expect(colleagueHeadline({ ...colleague, from: null })).toBeNull()
  })

  it('says the answer goes to the contact’s address on file, not to the sender, and that this reply paused them', () => {
    const note = answerComposerNote(colleague)
    expect(note).toBe(
      'This answer goes to Priya Shah’s address on file (priya@rentman.io), not to sam@rentman.io, the address this ' +
        'reply came from. Drafting resumes Priya Shah: this reply, filed under them, paused them in every campaign, ' +
        'and an approved answer to a paused person is refused. If the draft is denied, or the answer fails or is ' +
        'refused when it would be sent, the pause this reply caused goes back on — unless somebody resumes them ' +
        'before then, or another answer to them is still waiting.',
    )
    expect(note).not.toContain('their reply paused them')
    expect(answerComposerNote({ ...colleague, contactEmail: null })).toMatch(
      /^This answer goes to Priya Shah’s address on file, not to sam@rentman\.io, the address this reply came from\./,
    )
  })

  it('says, once drafted, that the reply filed under them — not theirs — had paused them', () => {
    expect(resumedLine(colleague)).toBe('Priya Shah is resumed — the reply filed under them had paused them in every campaign.')
    expect(resumedLine(own)).toBe('Priya Shah is resumed — their reply had paused them in every campaign.')
  })

  it('is fed from the row by the queue, for the headline, the composer and the drafted line', () => {
    expect(queue).toContain('const colleague = colleagueHeadline(senderOf(row))')
    expect(queue).toContain(
      '{colleague ? ( <> <strong>{colleague.sender}</strong> <span className="muted">— {colleague.note}</span> </> ) : (',
    )
    expect(queue).toContain('{answerComposerNote(senderOf(row))}')
    expect(queue).toContain('lines.push(resumedLine(senderOf(row)))')
    expect(queue).toContain('contactEmail: row.contact?.email ?? null')
    expect(queue).not.toContain('their reply paused them in every campaign')
  })

  /** What the composer says is true: an answer is addressed through the contact, never the reply's From. */
  it('is right about where the answer goes', () => {
    const outreach = readFileSync(fileURLToPath(new URL('../../../packages/db/src/outreach.ts', import.meta.url)), 'utf8')
    expect(outreach).toContain('const recipient = recipientFor(channel, row.contact)')
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
    // Review round 4: only an EMAIL reply has an Answer here, so only that
    // answer resumes them. A text is answered with Draft SMS, which refuses a
    // paused person and resumes nobody — the lede says to resume them first.
    expect(INBOX_LEDE).toContain('answering an email reply here resumes them, and the answer is a draft a person approves')
    expect(INBOX_LEDE).not.toContain('answering resumes them')
    expect(INBOX_LEDE).toContain('A text is answered with Draft SMS on /contacts, after resuming them there.')
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
  it('says nothing here reads a reply when neither a worker nor a webhook is configured', () => {
    const notes = inboxDeploymentNotes(BARE)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('so nothing here reads replies')
  })

  /**
   * `worker` is configuration. A worker on Fly sending against this
   * database leaves Message-IDs the webhook matches (`handleInboundEmail`
   * reads `provider_id` from the shared database), so "nothing has been sent
   * from this deployment, so there is no Message-ID to match" was false in
   * the documented production shape. Round 3, finding [20].
   */
  it('with a webhook and no worker configured, says how a reply is matched without claiming nothing was sent', () => {
    const notes = inboxDeploymentNotes({ ...BARE, inbound: 'webhook' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).not.toContain('nothing has been sent from this deployment')
    expect(notes[0]).not.toContain('there is no Message-ID to match')
    expect(notes[0]).toContain('no worker is configured here')
    expect(notes[0]).toContain('by the Message-ID of a message a worker sent')
    expect(notes[0]).toContain('then by an address on exactly one contact')
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

/**
 * The composer's line under an answer said "If the draft is then denied,
 * pause them again here." Since round 3 a deny does that itself, and since
 * round 4 so does an answer that fails or is refused when it would be sent
 * (`repauseForUnansweredReply` in packages/db/src/outreach.ts): the reply's
 * pause goes back on when this answer is what resumed them, nobody has
 * resumed them since, and no other answer to them is still on its way. The
 * line is JSX text in a client component, so it is read from the source,
 * whitespace collapsed.
 */
describe('what the answer composer says about a deny', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/inbox/queue.tsx', import.meta.url)), 'utf8')
    .replace(/\s+/g, ' ')
  const own = { fromIsContact: true, from: 'priya@rentman.io', contactName: 'Priya Shah', contactEmail: 'priya@rentman.io' }

  it('says the pause their reply caused goes back on, and when it does not', () => {
    expect(src).not.toContain('pause them again here')
    expect(answerComposerNote(own)).not.toContain('pause them again here')
    // Worded by sender.ts since review round 9, and rendered by the composer.
    expect(src).toContain('{answerComposerNote(senderOf(row))}')
    expect(answerComposerNote(own)).toBe(
      'Drafting resumes Priya Shah: their reply paused them in every campaign, and an approved answer to a paused ' +
        'person is refused. If the draft is denied, or the answer fails or is refused when it would be sent, the ' +
        'pause their reply caused goes back on — unless somebody resumes them before then, or another answer to ' +
        'them is still waiting.',
    )
  })

  it('names the deny, a failure and a refusal at sending as writers of that pause', () => {
    const outreach = readFileSync(fileURLToPath(new URL('../../../packages/db/src/outreach.ts', import.meta.url)), 'utf8')
    expect(outreach).toContain('export async function repauseForUnansweredReply(')
    expect(outreach).toContain("reason: 'their reply is unanswered again: the answer to it was denied'")
    expect(outreach).toContain("failed: 'their reply is unanswered again: the answer to it failed to send'")
    expect(outreach).toContain("refused: 'their reply is unanswered again: the answer to it was refused at sending'")
  })
})
