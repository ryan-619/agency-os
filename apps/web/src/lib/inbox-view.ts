import { z } from 'zod'
import type { ReplyKind } from '@agency/core'
import type { ReplyDraftRefusal } from '@agency/db/queries'
import { noRepliesReadNote, type Deployment } from './deployment-facts'

/**
 * What /inbox shows, and in what order, as pure functions (PROMPT.md §8.4).
 *
 * The page, the client queue and the two routes read their order, their
 * words and their validation from here, so the rule that matters most on
 * this screen — a person may set any kind EXCEPT `opted_out`, and may never
 * clear one — is written once and tested without a database. The query
 * refuses it too (`replyReclassify`'s predicate); this is the route's half.
 *
 * No `server-only` and no `@/` import: `test/inbox-view.test.ts` imports this
 * file, and vitest resolves neither.
 */

/** A group on the page: a stored kind, or the rows nobody has classified. */
export type InboxGroup = ReplyKind | 'unclassified'

/**
 * The reading order. Unclassified first — nobody has looked — then the kinds
 * in the order a person triages them, and `opted_out` last, because there is
 * nothing to do about one but read it. `inboxTouches` sorts by the same order
 * so the limit keeps the urgent rows.
 */
export const INBOX_GROUP_ORDER: readonly InboxGroup[] = [
  'unclassified', 'interested', 'wrong_person', 'not_now', 'other', 'auto_reply', 'opted_out',
]

export const INBOX_GROUP_LABELS: Readonly<Record<InboxGroup, string>> = {
  unclassified: 'Not classified yet',
  interested: 'Interested',
  wrong_person: 'Wrong person',
  not_now: 'Not now',
  other: 'Other',
  auto_reply: 'Automatic replies',
  opted_out: 'Asked to stop',
}

/** The kinds a PERSON may set. `opted_out` is absent on purpose. */
export type HumanReplyKind = Exclude<ReplyKind, 'opted_out'>

export const HUMAN_REPLY_KINDS: readonly HumanReplyKind[] = [
  'interested', 'wrong_person', 'not_now', 'other', 'auto_reply',
]

/** The group a stored kind belongs to. A value this build does not know is shown as unread, not guessed at. */
export function inboxGroupOf(kind: string | null): InboxGroup {
  return kind !== null && (INBOX_GROUP_ORDER as readonly string[]).includes(kind) && kind !== 'unclassified'
    ? (kind as ReplyKind)
    : 'unclassified'
}

/** Rows grouped in reading order, each group's rows in the order given. Empty groups are left out. */
export function groupInbox<T>(
  rows: readonly T[],
  kindOf: (row: T) => string | null,
): { readonly group: InboxGroup; readonly label: string; readonly rows: readonly T[] }[] {
  const byGroup = new Map<InboxGroup, T[]>()
  for (const row of rows) {
    const g = inboxGroupOf(kindOf(row))
    const list = byGroup.get(g) ?? []
    list.push(row)
    byGroup.set(g, list)
  }
  return INBOX_GROUP_ORDER.flatMap((group) => {
    const list = byGroup.get(group)
    return list && list.length > 0 ? [{ group, label: INBOX_GROUP_LABELS[group], rows: list }] : []
  })
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

export const INBOX_LEDE =
  'Every reply that reached this system, newest first. A reply pauses the person in every campaign; ' +
  'answering resumes them, and the answer is a draft a person approves.'

export const OPTED_OUT_NOTE = 'asked to stop — do not answer. The suppression row is what enforces it.'

/** An opted-out row whose suppression could not be written. §2.1: never silently. */
export const OPTED_OUT_NOT_SUPPRESSED_NOTE =
  'This reply asked to stop, but no suppression row matches this person. Add one on the suppressions page — ' +
  'until then nothing but the pause stands between them and the next message.'

export const RECLASSIFY_HINT = 'an opt-out is decided by the person’s own words, never here.'

export const ANSWER_DRAFTED_NOTE =
  'This is a draft. A person approves it on /approvals and the worker sends it after re-checking every rule; ' +
  'it threads under their reply.'

export const ANSWER_OPTED_OUT_ERROR = 'this person asked to stop; the suppression row is what enforces it'

/** Where the latest answer to a reply got to, in a person's words. */
export function answerStateWords(status: string): string {
  switch (status) {
    case 'awaiting_approval':
      return 'an answer is waiting on /approvals'
    case 'approved':
    case 'queued':
      return 'an answer is approved and waiting for the worker'
    case 'sending':
      return 'an answer is being sent'
    case 'sent':
    case 'delivered':
      return 'answered'
    case 'refused':
      return 'the last answer was denied or refused — it was not sent'
    case 'failed':
      return 'the last answer failed to send'
    default:
      return `the last answer is ${status.replace(/_/g, ' ')}`
  }
}

/** Whether an answer in this status is still on its way — the same set `replyQueueDraft` refuses a second one for. */
export function answerIsLive(status: string): boolean {
  return status === 'queued' || status === 'awaiting_approval' || status === 'approved' || status === 'sending'
}

/**
 * The sentences at the top of the page when this deployment's configuration
 * cannot keep the page's promise: nothing configured to read replies at all,
 * or a webhook with no worker configured.
 *
 * Configuration only, worded as such: a worker on Fly can be sending against
 * this database while this web half holds no AGENT_URL, and the webhook then
 * matches its Message-IDs in the shared database (`handleInboundEmail` reads
 * `provider_id`). "Nothing has been sent from this deployment, so there is no
 * Message-ID to match" was false in exactly that shape. Round 3, [20].
 */
export function inboxDeploymentNotes(d: Deployment): string[] {
  const notes: string[] = []
  const none = noRepliesReadNote(d)
  if (none) notes.push(none)
  if (!d.worker && d.inbound === 'webhook') {
    notes.push(
      'Replies reach this deployment through a webhook, and no worker is configured here. A reply is matched ' +
        'first by the Message-ID of a message a worker sent, then by an address on exactly one contact — so if ' +
        'no worker sends against this database, only the address can place a reply.',
    )
  }
  return notes
}

/** A person's name as the inbox shows it: their name, else their address, else a plain placeholder. */
export function personName(
  c: { readonly firstName: string | null; readonly lastName: string | null; readonly email: string | null } | null,
): string {
  if (!c) return 'a contact no longer in the CRM'
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'an unnamed contact'
}

// ---------------------------------------------------------------------------
// The two request bodies (zod at the boundary, §10)
// ---------------------------------------------------------------------------

export const ANSWER_SUBJECT_MAX = 200
export const ANSWER_BODY_MAX = 4000
/**
 * Both routes refuse a request body longer than this before parsing it —
 * measured as the book route measures, in string length, which is also what
 * the two maxima above count. The largest valid answer is about 4,300.
 */
export const INBOX_MAX_REQUEST_BYTES = 8 * 1024

/** "Re: " once, however many the thread has collected, clipped to the limit. */
export function answerSubject(subject: string | null): string {
  const bare = (subject ?? '').replace(/^\s*((re|aw|sv)\s*:\s*)+/i, '').trim()
  return `Re: ${bare || 'your reply'}`.slice(0, ANSWER_SUBJECT_MAX)
}

/**
 * PATCH /api/inbox/[id]. The kind is an enum of the FIVE — so `opted_out`
 * fails here, before the query's own predicate ever sees it.
 */
export const inboxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('handled') }),
  z.object({
    action: z.literal('reclassify'),
    kind: z.enum(['interested', 'wrong_person', 'not_now', 'other', 'auto_reply'], {
      error: `Choose interested, wrong person, not now, other or automatic reply — ${RECLASSIFY_HINT}`,
    }),
  }),
], { error: 'action must be handled or reclassify' })
export type InboxAction = z.infer<typeof inboxActionSchema>

/** POST /api/inbox/[id]/reply. */
export const answerSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, 'Give the answer a subject.')
    .max(ANSWER_SUBJECT_MAX, `A subject is at most ${ANSWER_SUBJECT_MAX} characters.`),
  body: z
    .string()
    .trim()
    .min(1, 'Write the answer first.')
    .max(ANSWER_BODY_MAX, `An answer is at most ${ANSWER_BODY_MAX} characters.`),
  campaignId: z.uuid('That is not a campaign.').nullish(),
})
export type AnswerInput = z.infer<typeof answerSchema>

/** A zod failure as one sentence for the person who pressed the button. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That request could not be read.'
}

/** The HTTP status for each reason `replyQueueDraft` refuses, and the words where the query's are not the route's. */
export const ANSWER_REFUSAL_STATUS: Readonly<Record<ReplyDraftRefusal, number>> = {
  not_found: 404,
  no_contact: 409,
  no_address: 409,
  no_campaign: 400,
  wrong_channel: 400,
  opted_out: 409,
  consent_refused: 409,
  already_queued: 409,
}
