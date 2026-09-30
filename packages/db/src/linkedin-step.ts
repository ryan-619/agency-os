/**
 * The LinkedIn provider is a person (§2.1, §8.4).
 *
 * LinkedIn has no automated provider and must never have one: automating a
 * personal account is against the platform's terms, and a cold channel §2.1
 * permits is still a channel somebody can ask to be left alone on. So the
 * sender is a person, and this module is the `MessageProvider` that person
 * stands behind. `dispatchTouch` stays the ONLY caller of a provider; the
 * alternative was a second sender in a route, which is the thing §8.4
 * forbids.
 *
 * ## Two steps, because the words must not leave before the rules say yes
 *
 * The obvious flow — show the words, let the person send them, then press
 * "I sent it" and run the rules — checks §2.1 AFTER the message has gone. A
 * suppression written a minute earlier would leave a row saying `refused`
 * about a message that was already sent, and a quiet-hours deferral would put
 * the row back in the list for the same message to go twice. Found by review.
 *
 *   Start        claims the row (`sending`) and runs `dispatchTouch` with a
 *                provider whose `send()` HANDS OVER the words. That is the
 *                only way the text reaches the step's copy control: a refusal
 *                or a deferral hands over nothing, so nothing can be sent
 *                against a row the rules stopped. On success the row settles
 *                `sent` at that moment, `provider_id` names the person
 *                (`human:<userId>`), the deal moves to `contacted`, and an
 *                audit row says who was handed the message.
 *   I sent it    closes the step's task. The row already says `sent`: it was
 *                handed to the provider, which is what `sent` means for SMTP
 *                too.
 *   I did not    the person was handed it and could not send it. The row
 *                becomes `failed` — the rules said yes and the transport did
 *                not deliver, which is exactly what `failed` means — so the
 *                record never claims a message nobody sent.
 *
 * ## The step list is materialised on read
 *
 * Every `approved` LinkedIn touch, and every `queued` one an auto-send
 * campaign produced (the person's click is the approval the campaign waived;
 * before this, nobody ever sent those), gets one open `linkedin_send` task —
 * `tasks_one_open_per_touch` arbitrates two page loads. Reading the list is
 * also where the web reconciles its own claims: a Start request that died
 * between the claim and the settle (a serverless timeout, a deploy) leaves a
 * row `sending` that no worker will ever recover, because the worker never
 * claims LinkedIn. Past `LINKEDIN_STEP_STUCK_MINUTES` it is marked `failed`,
 * the safe direction `recoverStuckSends` takes and for the same reason.
 *
 * Audit rows carry ids only (§2.3). Never the words, never the profile.
 */
import { and, asc, eq, inArray, isNull, like, lt, sql } from 'drizzle-orm'
import { normaliseLinkedIn, type Channel, type SendRefusalCode } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { dispatchTouch, type MessageProvider, type TouchRow } from './outreach.js'
import { previewSend, type SendPreview } from './send-preview.js'
import { tasksComplete, tasksCreate, tasksOpenForTouch } from './tasks.js'

/** What a person is handed when the send path says yes. */
export interface LinkedinWords {
  /** The recipient as the send path resolved it — the contact's `linkedin_url`. */
  readonly to: string
  /**
   * A link built from the normalised profile key, never the stored string:
   * `linkedin_url` is free text from an import or a form, and rendering it as
   * an href would let `javascript:` through. Null when it cannot be read.
   */
  readonly profileUrl: string | null
  readonly subject: string
  readonly body: string
}

/** `provider_id` for a message a person was handed. */
const HUMAN_PREFIX = 'human:'

/**
 * The provider that is a person.
 *
 * `send()` sends nothing. It hands the words to whoever pressed Start —
 * through `hand`, so the text the step shows is exactly the recipient and
 * body `dispatchTouch` gave its provider, not a second read of the row — and
 * answers `human:<userId>`, so the row names who has the message.
 */
export function linkedinHumanProvider(
  userId: string,
  hand?: (words: LinkedinWords) => void,
): MessageProvider {
  return {
    name: 'human',
    channels: ['linkedin'],
    async send(message) {
      hand?.({
        to: message.to,
        profileUrl: linkedinProfileUrl(message.to),
        subject: message.subject,
        body: message.body,
      })
      return { providerId: `${HUMAN_PREFIX}${userId}` }
    },
  }
}

/** `https://www.linkedin.com/in/<slug>` from the 0016 key, or null. */
export function linkedinProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = normaliseLinkedIn(raw)
  return key ? `https://www.linkedin.com/${key}` : null
}

/**
 * How long a Start may hold its claim before the list calls it dead. Well
 * past any serverless function's ceiling, so a slow request that is still
 * running is never marked failed under it.
 */
export const LINKEDIN_STEP_STUCK_MINUTES = 30

/**
 * The stuck-claim sentence. `recoverStuckSends` (apps/agent/src/boot/
 * reconcile.ts) says the same thing about a worker; this says it about a
 * request, and names the conversation to check instead of a mailbox.
 */
export const LINKEDIN_STEP_STUCK_ERROR =
  'The request that was sending this was interrupted. It may or may not have gone; check the LinkedIn conversation, then re-approve to send it again.'

/** What `failed` says when the person handed a message could not send it. */
export const LINKEDIN_STEP_NOT_SENT_ERROR =
  'Handed to a person to send from their own LinkedIn account, and they said it was not sent. Nothing went from here.'

/** The refusals that are about the clock, not the person. */
const CLOCK_CODES: readonly SendRefusalCode[] = ['quiet_hours', 'daily_cap', 'campaign_inactive']

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Where a step stands.
 *
 * - `ready`    `approved` or `queued`: Start runs the rules now.
 * - `sending`  somebody pressed Start a moment ago and it has not settled.
 * - `handed`   the rules said yes and a person has the words; waiting for
 *              "I sent it" or "I did not send it".
 * - `stopped`  anything else with an open task — a refusal, a failure, a
 *              message sent back for approval — shown with its reason until
 *              a person closes it.
 */
export type LinkedinStepState = 'ready' | 'sending' | 'handed' | 'stopped'

export interface LinkedinStep {
  readonly taskId: string
  readonly touchId: string
  readonly state: LinkedinStepState
  /** The touch's own status, for a screen that wants to say it. */
  readonly status: string
  readonly companyId: string | null
  readonly companyDomain: string | null
  readonly companyName: string | null
  readonly contactId: string | null
  readonly contactName: string | null
  readonly profileUrl: string | null
  readonly campaignId: string | null
  readonly campaignName: string | null
  /** When a deferral said to try again; the rules decide, this is a hint. */
  readonly scheduledFor: Date | null
  readonly approvedAt: Date | null
  readonly assigneeUserId: string | null
  readonly dueAt: Date | null
  /**
   * `ready` only: the dry run of the send path, BEFORE anybody presses Start.
   * Null when the row has no contact or campaign to check against.
   */
  readonly preview: SendPreview | null
  /** `handed` only: the words the person was given, and who. */
  readonly words: LinkedinWords | null
  readonly handedTo: { readonly userId: string; readonly label: string | null } | null
  readonly handedAt: Date | null
  /** `stopped` only. */
  readonly refusalCode: string | null
  readonly error: string | null
}

const LIST_LIMIT = 200

function personName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((s) => s && s.trim()).join(' ').trim()
  return name || null
}

/** A title that always fits 0018's 200-character bound. */
function stepTitle(contactName: string | null, company: string | null): string {
  const who = contactName ?? 'the contact'
  const title = `Send on LinkedIn to ${who}${company ? ` at ${company}` : ''}`
  return Array.from(title).slice(0, 200).join('')
}

/**
 * Every LinkedIn step in an org, each with its task.
 *
 * Writes, on purpose, and only three things: the stuck-claim sweep, one task
 * per `approved`/`queued` LinkedIn touch that has none, and those tasks'
 * `task.created` audit rows. That is what lets the list work on a deployment
 * with no worker at all.
 */
export async function linkedinStepsDue(
  db: AgencyDb,
  orgId: string,
  now: Date = new Date(),
): Promise<LinkedinStep[]> {
  // 1. The web reconciles its own claims. Coalesced like recoverStuckSends:
  //    `updated_at` is NULL until the first UPDATE.
  const cutoff = new Date(now.getTime() - LINKEDIN_STEP_STUCK_MINUTES * 60_000)
  await db
    .update(schema.touches)
    .set({ status: 'failed', error: LINKEDIN_STEP_STUCK_ERROR })
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.channel, 'linkedin'),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.status, 'sending'),
        lt(sql`coalesce(${schema.touches.updatedAt}, ${schema.touches.createdAt})`, cutoff),
      ),
    )

  // 2. Materialise: every live LinkedIn touch without an open task gets one.
  const live = await db
    .select({ touchId: schema.touches.id })
    .from(schema.touches)
    .leftJoin(schema.tasks, and(eq(schema.tasks.touchId, schema.touches.id), isNull(schema.tasks.doneAt)))
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.channel, 'linkedin'),
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.status, ['approved', 'queued']),
        isNull(schema.tasks.id),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))
    .limit(LIST_LIMIT)
  for (const t of live) await ensureStepTask(db, orgId, t.touchId)

  // 3. The list is the open tasks, whatever their touch now says.
  const rows = await db
    .select({
      task: schema.tasks,
      touch: schema.touches,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
      contactLinkedin: schema.contacts.linkedinUrl,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      campaignName: schema.campaigns.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.touches, and(eq(schema.touches.id, schema.tasks.touchId), eq(schema.touches.orgId, orgId)))
    .leftJoin(schema.contacts, and(eq(schema.contacts.id, schema.touches.contactId), eq(schema.contacts.orgId, orgId)))
    .leftJoin(schema.companies, and(eq(schema.companies.id, schema.touches.companyId), eq(schema.companies.orgId, orgId)))
    .leftJoin(schema.campaigns, and(eq(schema.campaigns.id, schema.touches.campaignId), eq(schema.campaigns.orgId, orgId)))
    .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.kind, 'linkedin_send'), isNull(schema.tasks.doneAt)))
    .orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.id))
    .limit(LIST_LIMIT)

  const handedIds = [
    ...new Set(rows.filter((r) => isHanded(r.touch)).map((r) => r.touch.providerId!.slice(HUMAN_PREFIX.length))),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const people = handedIds.length === 0
    ? []
    : await db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, handedIds)))
  const label = new Map(people.map((p) => [p.id, p.name ?? p.email]))

  const steps: LinkedinStep[] = []
  for (const r of rows) {
    const t = r.touch
    const state = stateOf(t)
    const preview = state === 'ready' && t.contactId && t.campaignId
      ? await previewSend(db, { orgId, contactId: t.contactId, campaignId: t.campaignId, now })
      : null
    const handedUser = state === 'handed' ? t.providerId!.slice(HUMAN_PREFIX.length) : null
    steps.push({
      taskId: r.task.id,
      touchId: t.id,
      state,
      status: t.status,
      companyId: t.companyId,
      companyDomain: r.companyDomain,
      companyName: r.companyName,
      contactId: t.contactId,
      contactName: personName(r.contactFirst, r.contactLast),
      profileUrl: linkedinProfileUrl(state === 'handed' ? (t.recipient ?? r.contactLinkedin) : r.contactLinkedin),
      campaignId: t.campaignId,
      campaignName: r.campaignName,
      scheduledFor: t.scheduledFor,
      approvedAt: t.approvedAt,
      assigneeUserId: r.task.assigneeUserId,
      dueAt: r.task.dueAt,
      preview,
      words: state === 'handed'
        ? {
            to: t.recipient ?? '',
            profileUrl: linkedinProfileUrl(t.recipient),
            subject: t.subject ?? '',
            body: t.body ?? '',
          }
        : null,
      handedTo: handedUser ? { userId: handedUser, label: label.get(handedUser) ?? null } : null,
      handedAt: state === 'handed' ? t.sentAt : null,
      refusalCode: state === 'stopped' ? t.refusalCode : null,
      error: state === 'stopped' ? t.error : null,
    })
  }
  return steps
}

function isHanded(t: Pick<TouchRow, 'status' | 'providerId'>): boolean {
  return t.status === 'sent' && typeof t.providerId === 'string' && t.providerId.startsWith(HUMAN_PREFIX)
}

function stateOf(t: TouchRow): LinkedinStepState {
  if (t.status === 'approved' || t.status === 'queued') return 'ready'
  if (t.status === 'sending') return 'sending'
  if (isHanded(t)) return 'handed'
  return 'stopped'
}

/**
 * The one open task for this touch, creating it if there is none. The unique
 * index decides between two callers; the loser re-reads the winner's.
 */
async function ensureStepTask(db: AgencyDb, orgId: string, touchId: string): Promise<string | null> {
  const existing = await tasksOpenForTouch(db, orgId, touchId)
  if (existing) return existing.id
  const [names] = await db
    .select({
      first: schema.contacts.firstName,
      last: schema.contacts.lastName,
      companyName: schema.companies.name,
      companyDomain: schema.companies.domain,
    })
    .from(schema.touches)
    .leftJoin(schema.contacts, and(eq(schema.contacts.id, schema.touches.contactId), eq(schema.contacts.orgId, orgId)))
    .leftJoin(schema.companies, and(eq(schema.companies.id, schema.touches.companyId), eq(schema.companies.orgId, orgId)))
    .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.id, touchId)))
    .limit(1)
  const created = await tasksCreate(db, {
    orgId,
    kind: 'linkedin_send',
    title: stepTitle(personName(names?.first ?? null, names?.last ?? null), names?.companyName ?? names?.companyDomain ?? null),
    detail:
      'Sent by a person, from their own LinkedIn account. Start it from the LinkedIn steps on Tasks: ' +
      'every send rule is checked at that moment, and the words are shown only if they pass.',
    touchId,
    createdBy: null,
    actor: 'system',
  })
  if (created.ok) return created.task.id
  if (created.reason === 'duplicate_open_for_touch') return (await tasksOpenForTouch(db, orgId, touchId))?.id ?? null
  return null
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type LinkedinPerformResult =
  | { readonly ok: true; readonly status: 'sent'; readonly words: LinkedinWords }
  | { readonly ok: true; readonly status: 'deferred'; readonly code: SendRefusalCode; readonly reason: string; readonly until: Date }
  | { readonly ok: true; readonly status: 'refused'; readonly code: SendRefusalCode; readonly reason: string }
  | {
      readonly ok: false
      readonly reason: 'not_found' | 'not_approved' | 'claimed' | 'wrong_channel'
      readonly message: string
    }

/**
 * Start a LinkedIn step: run the message through the one send path with a
 * person as the provider, and hand them the words only if it says yes.
 *
 * The claim is sender.ts's, exactly: one UPDATE with the live statuses in
 * its predicate, so two people pressing Start at once produce one hand-over
 * and one `claimed`. The ORIGINAL row goes to `dispatchTouch`, so it still
 * reads as approved or queued there and `approvedByHuman` is computed from
 * who approved it.
 */
export async function linkedinPerformStep(
  db: AgencyDb,
  args: { readonly orgId: string; readonly touchId: string; readonly userId: string; readonly now?: Date },
): Promise<LinkedinPerformResult> {
  const now = args.now ?? new Date()
  const [touch] = await db
    .select()
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.id, args.touchId),
        eq(schema.touches.direction, 'out'),
      ),
    )
    .limit(1)
  if (!touch) return { ok: false, reason: 'not_found', message: 'That message is not in the CRM.' }

  let handed: LinkedinWords | null = null
  const provider = linkedinHumanProvider(args.userId, (words) => {
    handed = words
  })

  // The provider's channel list, consulted BEFORE the claim: `dispatchTouch`
  // leaves a row it cannot carry exactly as it was, and a claim taken first
  // would strand that row in `sending`.
  if (!provider.channels.includes(touch.channel as Channel)) {
    return {
      ok: false,
      reason: 'wrong_channel',
      message: `This is a ${touch.channel} message. Only LinkedIn messages are sent by a person; nothing was changed.`,
    }
  }
  if (touch.status === 'sending') {
    return { ok: false, reason: 'claimed', message: 'Somebody started this step a moment ago.' }
  }
  if (touch.status !== 'approved' && touch.status !== 'queued') {
    return {
      ok: false,
      reason: 'not_approved',
      message: touch.status === 'sent'
        ? 'This message has already been handed to somebody to send.'
        : `This message is ${touch.status}, so there is nothing to send.`,
    }
  }

  // A step started through the route without the list ever being read still
  // gets its task, so "I sent it" always has something to close.
  await ensureStepTask(db, args.orgId, touch.id)

  const claimed = await db
    .update(schema.touches)
    .set({ status: 'sending' })
    .where(
      and(
        eq(schema.touches.id, touch.id),
        eq(schema.touches.orgId, args.orgId),
        inArray(schema.touches.status, ['approved', 'queued']),
      ),
    )
    .returning({ id: schema.touches.id })
  if (claimed.length === 0) {
    return { ok: false, reason: 'claimed', message: 'Somebody started this step a moment ago.' }
  }

  const result = await dispatchTouch(db, provider, touch, { now })

  if (result.sent) {
    const words = handed as LinkedinWords | null
    // `dispatchTouch` only reports `sent` after calling the provider, so the
    // words are always here; a missing hand-over is a bug, and it must not
    // look like a success the person can act on.
    if (!words) throw new Error('the send path said sent but handed nothing over')
    await appendAudit(db, {
      orgId: args.orgId,
      actor: args.userId,
      action: 'linkedin.handed',
      subjectType: 'touch',
      subjectId: touch.id,
      // §2.3: ids only. Never the words and never the profile.
      detail: { touchId: touch.id, campaignId: touch.campaignId, contactId: touch.contactId, userId: args.userId },
    }).catch(() => {})
    return { ok: true, status: 'sent', words }
  }

  if (result.decision.allowed) {
    // Unreachable: allowed and not sent means the provider was never asked.
    throw new Error('the send path allowed a message and did not send it')
  }
  const { code, reason } = result.decision

  /**
   * The clock is not a refusal. The other copy of this step is the worker's
   * tick in apps/agent/src/outreach/sender.ts, and `linkedin-step.test.ts`
   * runs both on twin rows and asserts they land identically: back to the
   * status it came from, no refusal code, and a `scheduled_for` an hour out
   * for quiet hours or six for the cap and a paused campaign. Neither is
   * precise and neither needs to be — Start re-checks the real rule.
   */
  if (CLOCK_CODES.includes(code)) {
    const retryAt = new Date(now.getTime() + (code === 'quiet_hours' ? 1 : 6) * 60 * 60 * 1000)
    await db
      .update(schema.touches)
      .set({ status: touch.status, refusalCode: null, scheduledFor: retryAt })
      .where(eq(schema.touches.id, touch.id))
    return { ok: true, status: 'deferred', code, reason, until: retryAt }
  }
  return { ok: true, status: 'refused', code, reason }
}

// ---------------------------------------------------------------------------
// Finishing a step
// ---------------------------------------------------------------------------

/**
 * - `sent`       "I sent it": the person handed the words sent them.
 * - `not_sent`   "I did not send it": they were handed and it did not go.
 * - `dismissed`  a stopped step, closed once somebody has read why.
 */
export type LinkedinStepOutcome = 'sent' | 'not_sent' | 'dismissed'

export type LinkedinFinishResult =
  | { readonly ok: true; readonly alreadyDone: boolean }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_handed' | 'still_live'; readonly message: string }

/**
 * Close a LinkedIn step's task, saying how it ended.
 *
 * The task is the arbiter: `tasksComplete` is one UPDATE with `done_at IS
 * NULL`, so "I sent it" and "I did not send it" pressed at once produce one
 * answer, and the loser is told `alreadyDone` without changing the row.
 */
export async function linkedinFinishStep(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly userId: string
    readonly outcome: LinkedinStepOutcome
    readonly now?: Date
  },
): Promise<LinkedinFinishResult> {
  const [touch] = await db
    .select()
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.id, args.touchId),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.channel, 'linkedin'),
      ),
    )
    .limit(1)
  if (!touch) return { ok: false, reason: 'not_found', message: 'That LinkedIn step is not in the CRM.' }

  const handed = isHanded(touch)
  if (args.outcome !== 'dismissed' && !handed) {
    return {
      ok: false,
      reason: 'not_handed',
      message: 'This message was never handed to anybody to send. Press Start first; the rules decide whether it may go.',
    }
  }
  if (args.outcome === 'dismissed') {
    const state = stateOf(touch)
    if (state !== 'stopped') {
      return {
        ok: false,
        reason: 'still_live',
        message: state === 'handed'
          ? 'Somebody was handed this message. Say whether it was sent instead.'
          : 'This message can still be sent. Deny it in Approvals if it should not go.',
      }
    }
  }

  const task = await tasksOpenForTouch(db, args.orgId, touch.id)
  if (!task) return { ok: true, alreadyDone: true }
  const done = await tasksComplete(db, {
    orgId: args.orgId,
    id: task.id,
    byUserId: args.userId,
    actor: args.userId,
    ...(args.now ? { now: args.now } : {}),
  })
  if (!done.ok) return { ok: false, reason: 'not_found', message: done.message }
  if (done.alreadyDone) return { ok: true, alreadyDone: true }

  if (args.outcome === 'not_sent') {
    // `sent_at` is cleared because nothing went: the daily cap counts it,
    // and so does anyone reading the row. `provider_id` stays — it names who
    // was handed the message, which is still true.
    await db
      .update(schema.touches)
      .set({ status: 'failed', sentAt: null, error: LINKEDIN_STEP_NOT_SENT_ERROR })
      .where(
        and(
          eq(schema.touches.id, touch.id),
          eq(schema.touches.status, 'sent'),
          like(schema.touches.providerId, `${HUMAN_PREFIX}%`),
        ),
      )
  }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.userId,
    action: `linkedin.${args.outcome}`,
    subjectType: 'touch',
    subjectId: touch.id,
    detail: { touchId: touch.id, taskId: task.id, campaignId: touch.campaignId },
  }).catch(() => {})
  return { ok: true, alreadyDone: false }
}
