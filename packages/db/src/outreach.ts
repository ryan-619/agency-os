/**
 * The send path's I/O half (PROMPT.md §8.4).
 *
 * The DECISION is `decideSend` in `packages/core`, pure and tested offline.
 * This gathers the facts it needs and obeys what it says. The split is the
 * point: the rules with legal consequences are in a function that needs no
 * database, and this file cannot reorder them, skip one, or add a special
 * case — it does not perform the checks, it only supplies their inputs.
 *
 * §8.4's order, end to end, with the three steps it does not name (a pause,
 * evidence past its re-verification deadline, and a bounce — see
 * `decideSend`):
 *
 *   suppression → consent → pause → stale evidence → bounce → quiet hours →
 *   daily cap → campaign status → approval gate
 *      ↑ gathered here, decided in core ↑
 *   → last look → provider send → write `touches` → write `audit_log`
 *      ↑ this file, from here on ↑
 *
 * ## The shape of a message's life
 *
 *   awaiting_approval  the agent's `queue_touch`, or a person's own draft;
 *                      a person reads it in /approvals …
 *   approved           … and says yes, naming a recipient and a campaign.
 *   queued             an auto-send campaign's message, needing nobody.
 *   → dispatchTouch    the ONE function that calls a provider. It re-runs
 *                      every §2.1 rule on the way — a human approved the
 *                      WORDS, not the recipient's opt-out status an hour later.
 *   sent | refused | failed
 *
 * `dispatchTouch` is the only function in this codebase that may cause a
 * message to leave the building, and it takes the provider as an argument so
 * that every channel and every test uses the same path.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import {
  decideSend, isStale, mentionsRemovalOrDeparture, normaliseEmail, ownWords, parseDsn,
  pauseReasonClass, pausedSentence, readMailSignals, staleAfterDaysOf, suppressionKeysFor,
  type Channel, type MailSignal, type SendDecision, type SendFacts, type SuppressionKind, classifyReply, type ReplyKind,
} from '@agency/core'
// 0019 (DoveSoft): the template facts and the SMS opt-out reader. A separate
// import so the line above stays as it was for a parallel edit to merge onto.
import {
  TEMPLATE_CHANNELS, matchesTemplate, smsOptOut, type TemplateCategory, type TemplateFacts,
} from '@agency/core'
// Review round 4: the deferrals a settle of an answer must not read as its end.
import { REFUSALS_THE_CLOCK_RESOLVES } from '@agency/core'
import * as schema from './schema.js'
import { activeIcpProfile, type AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { addSuppression } from './campaigns.js'
// Review round 5: a raced duplicate delivery is not an opt-out lost.
import { isUniqueViolation } from './pg-errors.js'
import { advanceDeal } from './deals.js'
// Review round 10, [2]: whether a pause is one Resume refuses until a shared
// number's unrecorded STOP is recorded — the gate's own answer, asked here
// so the sender and every dry run word the refusal alike.
import { heldForUnrecordedSharedNumber, resumeAsksSharedNumber } from './sms.js'

export type TouchRow = typeof schema.touches.$inferSelect

/**
 * Where an inbound path shouts when §2.1's obligation is not met. The worker
 * and the web route each have a logger; a caller that passes none gets a
 * structured line on stderr, because the one thing this must never be is
 * silent. Ids only — never an address, never a body.
 */
export interface InboundLog {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

const stderrLog: InboundLog = {
  error: (message, fields) => {
    console.error(JSON.stringify({ level: 'error', message, ...fields, at: new Date().toISOString() }))
  },
}

/**
 * What actually puts a message on the wire.
 *
 * An interface so SMTP and SendGrid sit behind the same shape (§8.4), and so
 * a test can assert the send path refuses WITHOUT a provider that could
 * accidentally deliver something. Note what it does NOT get: the decision. A
 * provider cannot be asked to decide, only to deliver.
 */
export interface MessageProvider {
  readonly name: string
  /**
   * What this provider can carry. An SMTP transport carries email and only
   * email; handed a LinkedIn touch it would mail whatever was in
   * `linkedin_url`, with the email suppression list never consulted. Found
   * by review. `dispatchTouch` refuses a channel the provider does not name,
   * and the sender never picks one up.
   */
  readonly channels: readonly Channel[]
  send(message: {
    readonly to: string
    readonly subject: string
    readonly body: string
    /**
     * Extra headers the send path built: `In-Reply-To`/`References` for an
     * answer to a reply, `List-Unsubscribe` from the worker. Optional, so a
     * provider that cannot carry headers — a person, on LinkedIn — still
     * satisfies the interface by ignoring them.
     */
    readonly headers?: Readonly<Record<string, string>>
    /**
     * 0019: the registration an SMS or WhatsApp message was checked against
     * — the DLT template id and header (or Meta's template name and the WABA
     * number) the operator compares the words with. Read by `dispatchTouch`
     * from the row the message names, never from a caller, and present on
     * every `TEMPLATE_CHANNELS` message that reaches a provider. A provider
     * for those channels refuses (throws) without it; email and LinkedIn
     * providers ignore it.
     */
    readonly template?: MessageTemplateRegistration
  }): Promise<{ readonly providerId: string }>
}

/** What a provider is told about the template a message was rendered from (0019). */
export interface MessageTemplateRegistration {
  /** DLT's content-template id (`tempid`), or Meta's template name. */
  readonly externalId: string
  /** The DLT header (`senderid`), or the WABA number. */
  readonly senderId: string
  readonly category: string
  readonly language: string
}

export interface SendRequest {
  readonly orgId: string
  readonly campaignId: string
  readonly contactId: string
  readonly companyId?: string | null
  readonly subject: string
  readonly body: string
  /** Injectable for tests; the caller passes `new Date()`. */
  readonly now?: Date
}

export interface SendResult {
  /**
   * The `touches` row this produced, or null.
   *
   * Null only when there was nothing to record it against — a campaign or
   * contact that no longer exists, or one belonging to another org. Writing a
   * row then would mean either a dangling foreign key or a message filed under
   * an org that never asked for it, and both are worse than the absence.
   * Every other path, refusals included, writes a row.
   */
  readonly touchId: string | null
  readonly decision: SendDecision
  readonly sent: boolean
}

/**
 * Send one message programmatically: record it, then dispatch it.
 *
 * The campaign engine's entry point. It exists so that "send this to this
 * contact under this campaign" is one call — but everything that matters
 * happens in `dispatchTouch`, which is also what an approved draft goes
 * through. Two entry points, one path.
 */
export async function sendOne(
  db: AgencyDb,
  provider: MessageProvider,
  req: SendRequest,
): Promise<SendResult> {
  const now = req.now ?? new Date()

  // The subject has to exist before a row can be filed against it. A row
  // pointing at a contact that is not there, or filed in an org that never
  // asked, is worse than no row — so this is checked before anything is
  // written, and the attempt is audited instead.
  const subject = await subjectExists(db, req.orgId, req.campaignId, req.contactId)
  if (!subject) {
    await appendAudit(db, {
      orgId: req.orgId,
      actor: 'system',
      action: 'send.no_such_subject',
      subjectType: 'campaign',
      subjectId: req.campaignId,
      detail: { contactId: req.contactId },
    }).catch(() => {})
    return {
      touchId: null,
      decision: {
        allowed: false,
        code: 'unparseable_recipient',
        reason: 'That campaign or contact no longer exists. Nothing was sent.',
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  // 0019: an SMS or WhatsApp message is a registered template or nothing,
  // and this entry point carries free text — so it cannot be queued (0019's
  // CHECK) and is recorded as the refusal the sender would give it: through
  // `decideSend` over these words with no template, so a person-level rule
  // (no opt-in, a suppression) is still the reason logged ahead of
  // `no_template`, in the decision's own order.
  if (TEMPLATE_CHANNELS.has(subject.channel as Channel)) {
    const gathered = await sendFactsFor(db, {
      orgId: req.orgId,
      campaignId: req.campaignId,
      contactId: req.contactId,
      approvedByHuman: false,
      evidenceAsOf: now,
      words: { templateId: null, body: req.body },
      now,
    })
    const decided = 'missing' in gathered ? null : decideSend(gathered.facts)
    const decision: SendDecision & { allowed: false } =
      decided && !decided.allowed
        ? decided
        : {
            allowed: false,
            code: 'no_template',
            reason: `${subject.channel === 'sms' ? 'An SMS' : 'A WhatsApp message'} is sent from a registered template, and this one has none. Nothing was sent.`,
            humanCanResolve: false,
          }
    const [refused] = await db
      .insert(schema.touches)
      .values({
        orgId: req.orgId,
        campaignId: req.campaignId,
        contactId: req.contactId,
        companyId: req.companyId ?? subject.companyId,
        channel: subject.channel,
        direction: 'out',
        status: 'refused',
        refusalCode: decision.code,
        subject: req.subject,
        body: req.body,
      })
      .returning({ id: schema.touches.id })
    await appendAudit(db, {
      orgId: req.orgId,
      actor: 'system',
      action: `send.${decision.code}`,
      subjectType: 'touch',
      subjectId: refused?.id ?? null,
      detail: { campaignId: req.campaignId, channel: subject.channel, code: decision.code },
    }).catch(() => {})
    return { touchId: refused?.id ?? null, decision, sent: false }
  }

  const rows = await db
    .insert(schema.touches)
    .values({
      orgId: req.orgId,
      campaignId: req.campaignId,
      contactId: req.contactId,
      companyId: req.companyId ?? subject.companyId,
      channel: subject.channel,
      direction: 'out',
      status: 'queued',
      subject: req.subject,
      body: req.body,
    })
    .returning()
  const touch = rows[0]
  if (!touch) throw new Error('touch insert returned no row')

  // Claim it before dispatching, exactly as the sender tick does. Between
  // the insert above and the provider below, a tick could otherwise find
  // this same `queued` row, claim it, and send it a second time. Found by
  // review. The claim must succeed here — nothing else has seen the row —
  // and if it somehow does not, the tick owns it now.
  const claimed = await db
    .update(schema.touches)
    .set({ status: 'sending' })
    .where(and(eq(schema.touches.id, touch.id), eq(schema.touches.status, 'queued')))
    .returning({ id: schema.touches.id })
  if (claimed.length === 0) {
    return {
      touchId: touch.id,
      decision: { allowed: false, code: 'needs_approval', reason: 'The worker picked this message up first; it will report on it.', humanCanResolve: true },
      sent: false,
    }
  }

  return dispatchTouch(db, provider, touch, { now })
}

/**
 * Take a message that is `approved` or `queued` and either send it or record
 * exactly why not.
 *
 * Every path leaves the row in a terminal, explained state. That is what lets
 * anyone answer "why did a campaign of 40 send 12?" — a refusal that left no
 * trace would make the send path silently lossy, which is the failure mode
 * that destroys trust in an outreach tool.
 */
export async function dispatchTouch(
  db: AgencyDb,
  provider: MessageProvider,
  touch: TouchRow,
  opts: {
    readonly now?: Date
    /**
     * Headers the CALLER adds to an outbound message — the worker's
     * `List-Unsubscribe`, for one. Merged over the threading headers this
     * function builds itself; a null return adds nothing. Never consulted for
     * the decision, which needs no headers.
     */
    readonly headersFor?: (touch: TouchRow) => Readonly<Record<string, string>> | null
  } = {},
): Promise<SendResult> {
  const now = opts.now ?? new Date()

  // Only these two statuses may reach a provider. Anything else arriving here
  // is a caller that skipped the queue, and it is refused rather than obeyed.
  if (touch.status !== 'approved' && touch.status !== 'queued') {
    return {
      touchId: touch.id,
      decision: {
        allowed: false,
        code: 'needs_approval',
        reason: `A message in status "${touch.status}" cannot be dispatched. Nothing was sent.`,
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  // A channel this provider cannot carry is left exactly as it is — not
  // refused, because a provider that CAN carry it may exist later — and the
  // caller is told. The sender's due query never hands over such a row in
  // the first place; this is the guard for a direct caller.
  if (!provider.channels.includes(touch.channel as Channel)) {
    return {
      touchId: touch.id,
      decision: {
        allowed: false,
        code: 'needs_approval',
        reason: `No configured provider sends ${touch.channel}. Nothing was sent; the message is left as it was.`,
        humanCanResolve: true,
      },
      sent: false,
    }
  }

  const facts = await gatherFacts(db, touch, now)
  if ('missing' in facts) {
    await settle(db, touch, { status: 'refused', refusalCode: 'unparseable_recipient', error: facts.missing }, now)
    return {
      touchId: touch.id,
      decision: { allowed: false, code: 'unparseable_recipient', reason: facts.missing, humanCanResolve: true },
      sent: false,
    }
  }

  // r4: worded for what made evidence stale — aged or superseded.
  const decision = decideGathered(facts)

  if (!decision.allowed) {
    if (decision.code === 'needs_approval') {
      // A `queued` message whose campaign turned auto-send OFF between
      // queueing and now. Not refused: it goes to a person, which is what the
      // campaign now asks for.
      await settle(db, touch, { status: 'awaiting_approval', refusalCode: null, recipient: facts.recipient }, now)
    } else {
      await settle(db, touch, { status: 'refused', refusalCode: decision.code, recipient: facts.recipient }, now)
    }
    await appendAudit(db, {
      orgId: touch.orgId,
      actor: 'system',
      action: `send.${decision.code}`,
      subjectType: 'touch',
      subjectId: touch.id,
      // §2.3: never the body, never the recipient. The rule and the campaign.
      detail: { campaignId: touch.campaignId, channel: facts.facts.channel, code: decision.code },
    }).catch(() => {})
    return { touchId: touch.id, decision, sent: false }
  }

  // Past every check. One last look before the wire: a reply can land
  // between `gatherFacts` reading the contact and this line, and the cancel
  // that reply performs skips rows that are already `sending`. Cheap, and
  // it closes the window to the width of the provider call itself. A bounce,
  // a suppression and an erasure recorded in the same window are the same
  // race, and get the same look — in `decideSend`'s order, so the reason
  // recorded is the one the decision would have given a moment later: an
  // unsubscribe writes a suppression AND a pause, and is the opt-out.
  if (touch.contactId) {
    const [fresh] = await db
      .select({
        pausedAt: schema.contacts.pausedAt,
        pausedReason: schema.contacts.pausedReason,
        emailBouncedAt: schema.contacts.emailBouncedAt,
      })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, touch.contactId))
      .limit(1)
    if (!fresh) {
      // The contact is GONE — an erasure committed between the facts and
      // here (erasure leaves a `sending` row alone; this worker owns it).
      // Undefined is not "not paused": it is a person who asked to be
      // forgotten, whose suppression rows went in first. Refused as a
      // revoked consent — the answer to them is no, and nobody may approve
      // past it — and the recipient is NOT written back: the erasure blanked
      // it on purpose. Found by review.
      await settle(db, touch, { status: 'refused', refusalCode: 'consent_revoked' }, now)
      return {
        touchId: touch.id,
        decision: {
          allowed: false,
          code: 'consent_revoked',
          reason: 'This contact was erased or deleted a moment ago. Nothing was sent.',
          humanCanResolve: false,
        },
        sent: false,
      }
    }
    // An unsubscribe click or a "stop" landing in the same window writes a
    // suppression row — and a pause beside it, which must not be what is
    // recorded: the opt-out is the stronger statement.
    if (await anySuppressionMatches(db, touch.orgId, suppressionKeysFor(facts.recipient, facts.facts.channel) ?? [])) {
      await settle(db, touch, { status: 'refused', refusalCode: 'suppressed', recipient: facts.recipient }, now)
      return {
        touchId: touch.id,
        decision: {
          allowed: false,
          code: 'suppressed',
          reason: 'This recipient was added to the suppression list a moment ago. Nothing was sent.',
          humanCanResolve: false,
        },
        sent: false,
      }
    }
    // A pause — a reply, or a teammate's hold — is refused as the pause it
    // is, never as a revoked consent: that code is the recipient's own no,
    // and enrolment reads it as one for good. Worded by its class, never its
    // text.
    if (fresh.pausedAt) {
      await settle(db, touch, { status: 'refused', refusalCode: 'paused', recipient: facts.recipient }, now)
      return {
        touchId: touch.id,
        decision: {
          allowed: false,
          code: 'paused',
          reason: `This contact was paused a moment ago. ${pausedSentence(pauseReasonClass(fresh.pausedReason))}`,
          humanCanResolve: false,
        },
        sent: false,
      }
    }
    if (fresh.emailBouncedAt && facts.facts.channel === 'email') {
      await settle(db, touch, { status: 'refused', refusalCode: 'bounced', recipient: facts.recipient }, now)
      return {
        touchId: touch.id,
        decision: { allowed: false, code: 'bounced', reason: 'This address bounced a moment ago. Nothing was sent. Correct the address.', humanCanResolve: true },
        sent: false,
      }
    }
  }

  // Threading, built HERE rather than by the caller: an outbound row that
  // answers a reply names it in `answers_touch_id` (0018), and the reply's
  // `provider_id` is the Message-ID the other side's client will look for in
  // In-Reply-To and References. One place, so every caller's answer threads.
  const headers: Record<string, string> = {}
  if (touch.answersTouchId) {
    const parent = await db
      .select({ providerId: schema.touches.providerId })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.id, touch.answersTouchId),
          eq(schema.touches.orgId, touch.orgId),
          eq(schema.touches.direction, 'in'),
        ),
      )
      .limit(1)
    const messageId = parent[0]?.providerId
    if (messageId) {
      headers['In-Reply-To'] = messageId
      headers['References'] = messageId
    }
  }
  Object.assign(headers, opts.headersFor?.(touch) ?? {})

  // 0019: the registration the words were checked against, for the
  // provider to name (DLT's `tempid` and `senderid`). `decideSend` has just
  // refused a template-channel message with none, and 0019's RESTRICT keeps
  // the row; a miss here is refused `no_template` all the same, never sent
  // bare.
  const template = TEMPLATE_CHANNELS.has(touch.channel as Channel)
    ? await registrationFor(db, touch)
    : undefined
  if (template === null) {
    await settle(db, touch, { status: 'refused', refusalCode: 'no_template', recipient: facts.recipient }, now)
    return {
      touchId: touch.id,
      decision: {
        allowed: false,
        code: 'no_template',
        reason: 'The registered template this message names could not be read a moment ago. Nothing was sent.',
        humanCanResolve: false,
      },
      sent: false,
    }
  }

  let providerId: string
  try {
    const sent = await provider.send({
      to: facts.recipient,
      subject: touch.subject ?? '',
      body: touch.body ?? '',
      headers,
      ...(template ? { template } : {}),
    })
    providerId = sent.providerId
  } catch (err) {
    // A provider failure is NOT a refusal — the rules said yes and the
    // transport did not work, which is a thing to retry. The distinction is
    // why `error` and `refusal_code` are separate columns.
    await settle(db, touch, {
      status: 'failed',
      refusalCode: null,
      recipient: facts.recipient,
      error: (err instanceof Error ? err.message : 'the provider failed').slice(0, 500),
    }, now)
    await appendAudit(db, {
      orgId: touch.orgId,
      actor: 'system',
      action: 'send.failed',
      subjectType: 'touch',
      subjectId: touch.id,
      detail: {
        campaignId: touch.campaignId,
        provider: provider.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    }).catch(() => {})
    throw err
  }

  // The message went. Recorded only while the row is still IN FLIGHT — the
  // claim this dispatch holds (`sending`, which every production caller
  // takes first) or, for a direct caller that did not claim, the status it
  // was handed — so a row somebody else settled meanwhile is not
  // overwritten. And the recipient is not written back to a row whose
  // contact is gone: an erasure during the provider call blanked it on
  // purpose. Found by review.
  //
  // One settled state IS corrected: a row a stuck-send recovery gave up on
  // while the provider had it — `failed`, never sent, no refusal. That
  // recovery means "may or may not have gone", and the provider's
  // acceptance is better evidence than that. Left as it was, the row kept
  // no `sent_at`, `provider_id` or recipient, so a reply or a bounce could
  // not be tied to this message by its Message-ID, an unsubscribe click on
  // it took the loud no-recipient path, and a supervised re-enrolment
  // drafted the same opener again. Found by review. The recovery's
  // sentence ("may or may not have gone; check … before drafting it again")
  // is cleared with it: on a row
  // that went, it is an instruction to send a duplicate — and for an answer
  // to a reply, the pause the recovery put back is lifted with it
  // (`recordRecoveredSend`, review round 5).
  const inFlight = await db
    .update(schema.touches)
    .set({ status: 'sent', sentAt: now, providerId, recipient: recipientUnlessErased(facts.recipient) })
    .where(and(eq(schema.touches.id, touch.id), inArray(schema.touches.status, ['sending', touch.status])))
    .returning({ id: schema.touches.id })
  const recorded =
    inFlight.length === 1 || (await recordRecoveredSend(db, touch, { now, providerId, recipient: facts.recipient }))
  if (!recorded) {
    // The provider took it; the row had already been settled by someone
    // else, in a state the provider's acceptance does not correct. The
    // audit row below still says it went, which is the truth.
    stderrLog.error('a sent message found its row already settled; the row was left as it was', {
      touchId: touch.id,
      orgId: touch.orgId,
      provider: provider.name,
    })
  }

  // A company that has been written to is `contacted`, unless it is already
  // further along. Forward only, so a follow-up never knocks a deal back.
  if (touch.companyId) {
    await advanceDeal(db, { orgId: touch.orgId, companyId: touch.companyId, to: 'contacted' }).catch(() => {})
  }

  // §8.4's last step, and §2.3's constraint on it: the audit row records that
  // a message went, to whom it was addressed by ID, and through what. Not the
  // subject and not the body.
  await appendAudit(db, {
    orgId: touch.orgId,
    actor: 'system',
    action: 'send.sent',
    subjectType: 'touch',
    subjectId: touch.id,
    detail: {
      campaignId: touch.campaignId,
      contactId: touch.contactId,
      channel: facts.facts.channel,
      provider: provider.name,
      providerId,
      approvedBy: touch.approvedBy,
    },
  }).catch(() => {})

  return { touchId: touch.id, decision, sent: true }
}

/**
 * Record as sent a row a stuck-send recovery gave up on while the provider
 * had it — `failed`, never sent, no refusal — and, for an ANSWER to a reply,
 * lift the pause that recovery put back (review round 5, [12]).
 *
 * `recoverStuckSends` re-pauses the person when the answer it gives up on
 * resumed them (`repauseForUnansweredReply`): it cannot know whether the
 * answer went, and a reply possibly unanswered must not leave them live. The
 * provider's acceptance answers that. Left on, the pause held a person whose
 * reply WAS answered, under an audit row saying the answer failed to send —
 * and answering the same reply again from /inbox resumed them, so a second
 * answer could follow the first. Lifted only while it is still that pause:
 * `liftRecoveryPause` says exactly when.
 *
 * Contact before touch, the order every writer that holds both takes
 * (review round 5, [13]: the reply, the bounce and the reclassify cancels
 * lock the contact and then that person's touches). Deadlock-free against
 * the recovery itself, which locks the touch first: this runs only after
 * the in-flight UPDATE matched nothing, and that UPDATE waited for whoever
 * held the row — the recovery — to commit.
 */
async function recordRecoveredSend(
  db: AgencyDb,
  touch: Pick<TouchRow, 'id' | 'orgId' | 'answersTouchId'>,
  sent: { readonly now: Date; readonly providerId: string; readonly recipient: string },
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    const contactId = touch.answersTouchId ? await lockReplyContact(tx, touch.orgId, touch.answersTouchId) : null
    const rows = await tx
      .update(schema.touches)
      .set({
        status: 'sent',
        sentAt: sent.now,
        providerId: sent.providerId,
        recipient: recipientUnlessErased(sent.recipient),
        error: null,
      })
      .where(
        and(
          eq(schema.touches.id, touch.id),
          eq(schema.touches.status, 'failed'),
          isNull(schema.touches.sentAt),
          isNull(schema.touches.refusalCode),
        ),
      )
      .returning({ id: schema.touches.id })
    if (rows.length === 0) return false
    if (contactId && touch.answersTouchId) {
      await liftRecoveryPause(tx, { orgId: touch.orgId, answer: { id: touch.id, answersTouchId: touch.answersTouchId }, contactId })
    }
    return true
  })
}

/**
 * Lift the pause a stuck-send recovery put back over an answer that went
 * after all — only while it is still that pause:
 *
 *  - the recovery wrote it: a `contact.paused` row naming this answer, ended
 *    `failed` (`repauseForUnansweredReply`'s shape);
 *  - nothing has been recorded about the person since — a later reply, a
 *    teammate's hold, an unsubscribe, a resume — compared in SQL against
 *    that row's stored `created_at`, never a `Date` read back. A reply that
 *    arrived meanwhile kept the recovery's reason (`pauseContact` keeps the
 *    first), and is unanswered;
 *  - no reply of theirs is stored since the answer was drafted — read from
 *    `touches`, not the log, whose row for a reply may be missing or stamped
 *    before the recovery's (review round 6, [15]);
 *  - the stored reason is still exactly the reply's `replied <instant>`
 *    (`resumeContact`'s `expectedReason`, in the UPDATE's own predicate).
 *
 * Then they are resumed, and `contact.resumed` names the answer — actor
 * `system`, the CLASS of the pause, never its text. Uncaught, inside the
 * caller's transaction, as the re-pause is. The contact must already be
 * locked by the caller.
 */
async function liftRecoveryPause(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly answer: { readonly id: string; readonly answersTouchId: string }
    readonly contactId: string
  },
): Promise<boolean> {
  const { orgId, answer, contactId } = args
  const [reply] = await db
    .select({ sentAt: schema.touches.sentAt, createdAt: schema.touches.createdAt })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.id, answer.answersTouchId),
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'in'),
      ),
    )
    .limit(1)
  if (!reply) return false

  const [repaused] = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'contact.paused'),
        eq(schema.auditLog.subjectType, 'contact'),
        eq(schema.auditLog.subjectId, contactId),
        sql`${schema.auditLog.detail}->>'answerTouchId' = ${answer.id}`,
        sql`${schema.auditLog.detail}->>'answerEnded' = 'failed'`,
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(1)
  if (!repaused) return false

  const since = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.subjectType, 'contact'),
        eq(schema.auditLog.subjectId, contactId),
        sql`${schema.auditLog.id} <> ${repaused.id}`,
        sql`${schema.auditLog.createdAt} >= (SELECT a.created_at FROM audit_log a WHERE a.id = ${repaused.id})`,
      ),
    )
    .limit(1)
  if (since.length > 0) return false

  // The log alone is not enough for a reply (review round 6, [15]): its
  // `contact.replied` row is written best-effort, and stamped with `now()`
  // — the reply transaction's START, which can fall before the recovery's
  // row though the reply committed after it. So the touches decide too: an
  // inbound row of theirs stored at or after the ANSWER was drafted, other
  // than the reply it answers, is a reply nobody has answered. Compared in
  // SQL against the answer's stored `created_at`. A reply in flight is not
  // missed: one inserted before the caller locked this contact held a
  // key-share lock on it, so that lock waited for the reply to commit and
  // this read sees it; one inserted after waits for this transaction, and
  // its own pause then lands on a person this has resumed.
  const newerReply = await db
    .select({ id: schema.touches.id })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.contactId, contactId),
        eq(schema.touches.direction, 'in'),
        sql`${schema.touches.id} <> ${answer.answersTouchId}`,
        sql`${schema.touches.createdAt} >= (SELECT a.created_at FROM touches a WHERE a.id = ${answer.id})`,
      ),
    )
    .limit(1)
  if (newerReply.length > 0) return false

  const reason = replyPauseReason(reply)
  if (!(await resumeContact(db, orgId, contactId, { expectedReason: reason }))) return false
  await appendAudit(db, {
    orgId,
    actor: 'system',
    action: 'contact.resumed',
    subjectType: 'contact',
    subjectId: contactId,
    detail: { reason: 'the answer to their reply went after all', pausedFor: pauseReasonClass(reason), answerTouchId: answer.id },
  })
  return true
}

/**
 * Write where a message got to. Every terminal state `dispatchTouch` records
 * goes through here.
 *
 * For an ANSWER to a reply that ends here without going — `failed` at the
 * provider, or `refused` for good — the reply's own pause goes back on in
 * the same transaction (`repauseForUnansweredReply`, review round 4): the
 * draft resumed them, and a reply nobody answered is not a person every
 * campaign may write to. Everything else is the one UPDATE it always was.
 */
async function settle(
  db: AgencyDb,
  touch: Pick<TouchRow, 'id' | 'orgId' | 'answersTouchId'>,
  state: { status: string; refusalCode: string | null; recipient?: string; error?: string },
  now: Date,
): Promise<void> {
  // A row a stuck-send recovery marked `failed` meanwhile (never sent, no
  // refusal) carries its "may or may not have gone; check … before drafting
  // it again". Settled here, this dispatch never reached the provider, so that
  // sentence is false of it and an instruction nobody can follow on a
  // refused row: it goes, unless this state brings an error of its own
  // (review round 5, [12]). Judged on the row as it stands, in the UPDATE.
  const recoveryError = sql`CASE WHEN ${schema.touches.status} = 'failed' AND ${schema.touches.sentAt} IS NULL AND ${schema.touches.refusalCode} IS NULL THEN NULL ELSE ${schema.touches.error} END`
  const write = (d: AgencyDb) =>
    d
      .update(schema.touches)
      .set({
        status: state.status,
        refusalCode: state.refusalCode,
        ...(state.recipient !== undefined ? { recipient: recipientUnlessErased(state.recipient) } : {}),
        error: state.error !== undefined ? state.error : recoveryError,
      })
      .where(eq(schema.touches.id, touch.id))
  const ended = touch.answersTouchId ? answerEndedBy(state.status, state.refusalCode) : null
  if (!ended || !touch.answersTouchId) {
    await write(db)
    return
  }
  const replyTouchId = touch.answersTouchId
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    // Contact before touch (review round 6, [13]): the reply's person first,
    // the lock `repauseForUnansweredReply` then re-takes, and only then the
    // answer's own row. Writing the answer first held its row while waiting
    // for the person — and an erasure holds the person while it scrubs that
    // very row, so the two deadlocked on a real Postgres and the erasure
    // took the loud "could not keep its suppression" path for a fault that
    // was never about a suppression.
    await lockReplyContact(tx, touch.orgId, replyTouchId)
    await write(tx)
    await repauseForUnansweredReply(tx, { orgId: touch.orgId, answer: touch, actor: 'system', because: ended, now })
  })
}

/**
 * The recipient to record on a row — unless its contact is gone.
 *
 * Every row `dispatchTouch` handles names a contact (it refuses one that
 * does not), so a NULL `contact_id` at the moment of writing means the
 * contact was deleted in between, and an erasure blanks `recipient` on every
 * outbound row as part of forgetting the person. Writing the address back
 * would undo that. Evaluated in the UPDATE itself, so there is no window
 * between a read and the write.
 */
function recipientUnlessErased(recipient: string) {
  return sql<string | null>`CASE WHEN ${schema.touches.contactId} IS NULL THEN ${schema.touches.recipient} ELSE ${recipient} END`
}

/** Whether any suppression row in this org matches one of these keys. */
async function anySuppressionMatches(
  db: AgencyDb,
  orgId: string,
  keys: readonly { readonly kind: SuppressionKind; readonly value: string }[],
): Promise<boolean> {
  if (keys.length === 0) return false
  const hits = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.orgId, orgId),
        or(...keys.map((k) => and(eq(schema.suppressions.kind, k.kind), eq(schema.suppressions.value, k.value)))),
      ),
    )
    .limit(1)
  return hits.length > 0
}

async function subjectExists(
  db: AgencyDb,
  orgId: string,
  campaignId: string,
  contactId: string,
): Promise<{ companyId: string; channel: string } | null> {
  const rows = await db
    .select({ companyId: schema.contacts.companyId, channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .innerJoin(
      schema.contacts,
      and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)),
    )
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The facts for one touch, or why there cannot be any.
 *
 * A thin wrapper over `sendFactsFor`: it decides what a ROW says about who
 * approved it, and hands everything else to the one fact-gatherer.
 */
async function gatherFacts(
  db: AgencyDb,
  touch: TouchRow,
  now: Date,
): Promise<
  // r4: the evidence halves ride along, for `decideGathered`'s wording —
  // and, review round 10, the shared-number hold.
  | { facts: SendFacts; recipient: string; evidenceAged: boolean; evidenceSuperseded: boolean; sharedNumberHold: boolean }
  | { missing: string }
> {
  if (!touch.campaignId) {
    // Every outbound message carries a campaign, because the campaign is
    // where the cap and the quiet hours live. A draft without one is a draft
    // the approver has not finished with.
    return { missing: 'This message has no campaign, so it has no daily cap or quiet hours. Nothing was sent.' }
  }
  if (!touch.contactId) {
    return { missing: 'This message has no recipient. Nothing was sent.' }
  }
  const gathered = await sendFactsFor(db, {
    orgId: touch.orgId,
    campaignId: touch.campaignId,
    contactId: touch.contactId,
    // r4: the ROW's channel — the one the provider is picked by — never the
    // campaign's. Review round 3, finding 2.
    channel: touch.channel as Channel,
    approvedByHuman: touch.status === 'approved' && touch.approvedBy !== null,
    evidenceAsOf: evidenceAsOfFor(touch),
    // 0019: the words this row holds, and the template it names.
    words: { templateId: touch.templateId, body: touch.body },
    now,
  })
  if ('missing' in gathered) return gathered
  // r4: a message whose campaign no longer sends on its channel is refused
  // here, as a message with no campaign is — unless a refusal nobody may
  // approve past outranks it (`channelMismatch`).
  const mismatch = channelMismatch(gathered, decideSend(gathered.facts))
  return mismatch === null ? gathered : { missing: mismatch }
}

/**
 * The refusal for words written for one channel under a campaign that now
 * sends on another — or null.
 *
 * The campaign is where a message's cap, quiet hours and status live, and a
 * campaign on the other channel holds none of them for these words: it is a
 * message with no campaign of its own, refused the way `gatherFacts` refuses
 * one with none (`unparseable_recipient`, with this sentence on the row).
 * Terminal: the words were written for a medium, and the fix is a new draft
 * under a campaign on it. Review round 3, finding 2 — a campaign switched
 * from LinkedIn to email while it held approved messages used to address
 * them by the campaign's channel.
 *
 * A refusal nobody may approve past — a suppression, a recorded refusal, a
 * pause, stale evidence, a cold channel — is judged on the words' OWN
 * channel and outranks this, so the reason recorded for somebody who opted
 * out is the opt-out. Exported for `previewSend`, which must say what the
 * sender will.
 */
export function channelMismatch(
  gathered: { readonly facts: SendFacts; readonly campaignChannel: Channel },
  decision: SendDecision,
): string | null {
  const channel = gathered.facts.channel
  if (channel === gathered.campaignChannel) return null
  if (!decision.allowed && !decision.humanCanResolve) return null
  const name = (c: Channel) => (c === 'linkedin' ? 'LinkedIn' : c === 'sms' ? 'SMS' : c === 'whatsapp' ? 'WhatsApp' : c)
  return (
    `This message was written for ${name(channel)}, and its campaign now sends ${name(gathered.campaignChannel)}, ` +
    `so it has no campaign on its own channel. Nothing was sent; draft it again under a ${name(channel)} campaign.`
  )
}

/**
 * The words a send-check is about, for the template steps (0019): the
 * template a message names and its body. On a `TEMPLATE_CHANNELS` channel
 * the sender judges these — never a caller's claim that they match.
 */
export interface MessageWords {
  readonly templateId: string | null
  readonly body: string | null
}

/**
 * The template facts for one message's words on a template channel, or null
 * when they name no template this org holds on this channel — the sender's
 * `no_template`. Read from the row, never from the caller: `matches` is
 * `matchesTemplate` over the stored body, the operator's own scrub run first.
 */
async function templateFactsFor(
  db: AgencyDb,
  orgId: string,
  channel: Channel,
  words: MessageWords | null,
): Promise<TemplateFacts | null> {
  if (!words?.templateId) return null
  const [row] = await db
    .select({ body: schema.messageTemplates.body, active: schema.messageTemplates.active, category: schema.messageTemplates.category })
    .from(schema.messageTemplates)
    .where(
      and(
        eq(schema.messageTemplates.id, words.templateId),
        eq(schema.messageTemplates.orgId, orgId),
        eq(schema.messageTemplates.channel, channel),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    active: row.active,
    matches: matchesTemplate(words.body ?? '', row.body),
    category: row.category as TemplateCategory,
  }
}

/**
 * The registration a template-channel message names, as its provider is told
 * it (0019), or null when the row names none this org holds on this
 * channel. Active or not: `decideSend` has already judged that.
 */
async function registrationFor(db: AgencyDb, touch: TouchRow): Promise<MessageTemplateRegistration | null> {
  if (!touch.templateId) return null
  const [row] = await db
    .select({
      externalId: schema.messageTemplates.externalId,
      senderId: schema.messageTemplates.senderId,
      category: schema.messageTemplates.category,
      language: schema.messageTemplates.language,
    })
    .from(schema.messageTemplates)
    .where(
      and(
        eq(schema.messageTemplates.id, touch.templateId),
        eq(schema.messageTemplates.orgId, touch.orgId),
        eq(schema.messageTemplates.channel, touch.channel),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * A STORED message's words, as the stale-evidence step asks about them: the
 * row, by id, whose `created_at` is the moment they were written.
 *
 * The id is what is compared, in SQL, against the stored value. `writtenAt`
 * is that same instant read back as a `Date` — for a screen to show, or to
 * key by — and is never what decides: a `Date` holds milliseconds and
 * `timestamptz` microseconds, so `ran_at <= writtenAt` asked about the START
 * of the draft's millisecond, and a scan stamped inside it, a few hundred
 * microseconds before the words, was not seen. The sender read "no scan
 * behind these words" while `/compliance`, comparing in SQL, read the same
 * row as written from that scan and refused at sending. Found by review.
 */
export interface StoredWords {
  readonly touchId: string
  readonly writtenAt: Date
}

/**
 * When the words a send-check is about were written:
 *
 *  - `StoredWords` — a stored message (`evidenceAsOfFor`), judged against
 *    its stored `created_at`;
 *  - a `Date` — a message nobody has stored yet, written at that instant
 *    (the moment a dry run is asked);
 *  - `null` — an answer to a reply, which quotes no scan.
 */
export type EvidenceAsOf = StoredWords | Date | null

/**
 * The moment a stored message's WORDS were written, for the stale-evidence
 * step: its row, whose `created_at` decides — or null for an answer to a
 * reply, which quotes no scan. Exported so a screen previewing a stored draft
 * asks the question the sender will ask about it (`previewSend`'s
 * `writtenAt`).
 */
export function evidenceAsOfFor(touch: {
  readonly id: string
  readonly createdAt: Date
  readonly answersTouchId: string | null
}): StoredWords | null {
  return touch.answersTouchId ? null : { touchId: touch.id, writtenAt: touch.createdAt }
}

/**
 * Everything `decideSend` needs, gathered in one place.
 *
 * Deliberately gathered in ONE place. A caller assembling these itself is a
 * caller that can forget the domain half of the suppression lookup, or read
 * the sender's timezone, and those are the bugs the whole design is arranged
 * to make impossible.
 *
 * Exported so a DRY RUN (`previewSend` in send-preview.ts) reads exactly what
 * the sender reads and writes nothing. Every screen that says "could we
 * message this person?" reads it from here, through that; a screen with its
 * own idea of the facts is a screen that can disagree with the sender at the
 * moment somebody trusted it. Beside the facts it reports HOW some of them
 * were arrived at — whose zone, whether the contact is paused and why, and
 * the consent row as recorded — for the screen to show; the decision does
 * not read those.
 */
export async function sendFactsFor(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly campaignId: string
    readonly contactId: string
    readonly approvedByHuman: boolean
    /**
     * When the WORDS were written — a stored message's row
     * (`evidenceAsOfFor`), whose stored `created_at` is compared in SQL, or
     * the moment a hypothetical one would be. Null for a message that quotes
     * no scan: an answer to a reply.
     *
     * Required, so a caller cannot forget the question. The evidence behind
     * the words is the latest SUCCESSFUL scan of the contact's company at or
     * before this moment — the scan a draft written then could have quoted —
     * and it is judged stale by `isStale` on that scan's `ran_at` at `now`,
     * never by `findings.stale`. A later re-scan does not freshen words that
     * were written before it; a new draft does.
     */
    readonly evidenceAsOf: EvidenceAsOf
    /**
     * The words, for the template steps on SMS and WhatsApp (0019). Omitted:
     * the stored message `evidenceAsOf` names, when it names one — so a
     * screen previewing a stored draft asks what the sender will ask —
     * and otherwise nothing is known about the words (`wordsKnown: false`),
     * which the decision reads as no template. Ignored on other channels.
     */
    readonly words?: MessageWords
    /**
     * The channel the WORDS were written for — a stored row's own
     * `touches.channel`, which is what the provider is picked by. Omitted:
     * the stored message `evidenceAsOf` names, when it names one, and the
     * campaign's channel only for words nobody has stored. Review round 3,
     * finding 2: the campaign's channel decided the recipient, the
     * suppression keys, consent and the bounce for every message, so a
     * campaign switched from LinkedIn to email checked a LinkedIn message
     * against the email keys.
     */
    readonly channel?: Channel
    readonly now: Date
  },
): Promise<
  | {
      facts: SendFacts
      recipient: string
      zoneFrom: 'contact' | 'company' | null
      /**
       * Whether the template fact is about real words — given, or read off
       * a stored message. False on a template channel when neither was
       * there: `facts.template` is then null, which is the sender's
       * `no_template`, and `previewSend` asks a person-level question in its
       * place. Always true off the template channels.
       */
      wordsKnown: boolean
      paused: boolean
      /** Why they are paused, as recorded — null when they are not. */
      pausedReason: string | null
      /** The consent row for this channel AS STORED — the same value as `facts.consent`. */
      consentRecorded: { granted: boolean; source: string } | null
      /**
       * The campaign's channel. Differs from `facts.channel` only for words
       * written for another one — `channelMismatch` says what that means.
       */
      campaignChannel: Channel
      /**
       * The two halves of `facts.evidenceStale` (r4, review round 3,
       * finding 4): the scan behind the words is past its deadline now
       * (`evidenceAged`), or a newer SUCCESSFUL scan of the company has
       * superseded it (`evidenceSuperseded`). Either refuses the words;
       * `decideGathered` words the refusal by which it was.
       */
      evidenceAged: boolean
      evidenceSuperseded: boolean
      /**
       * Whether they are paused AND Resume refuses to lift that pause until
       * a shared number's STOP is recorded (`heldForUnrecordedSharedNumber`,
       * the gate's own question, review round 10, [2]): a holder of a number
       * whose STOP could not be recorded in their org, whose own pause — a
       * teammate's, an unsubscribe's — stood instead of the hold, and so
       * reads as any pause of its class, which a person lifts with Resume.
       * Asked only of a paused contact: it is about what lifts a pause.
       * `decideGathered` words the `paused` refusal by it.
       */
      sharedNumberHold: boolean
    }
  | { missing: string }
> {
  const { orgId, campaignId, contactId, now } = args

  const rows = await db
    .select({
      campaign: schema.campaigns,
      contact: schema.contacts,
      companyTimeZone: schema.companies.timeZone,
    })
    .from(schema.campaigns)
    .innerJoin(
      schema.contacts,
      and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)),
    )
    .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
    .limit(1)

  const row = rows[0]
  if (!row) return { missing: 'That campaign or contact no longer exists. Nothing was sent.' }

  // r4 (review round 3, finding 2): the WORDS' channel. A stored message is
  // addressed, suppression-checked and consent-checked on its own channel,
  // the one `dispatchTouch` picks the provider by; only words nobody has
  // stored take the campaign's. A mismatch is not resolved here — the
  // facts are about the words — and `channelMismatch` refuses it.
  const campaignChannel = row.campaign.channel as Channel
  const channel = args.channel ?? (await storedChannel(db, orgId, args.evidenceAsOf)) ?? campaignChannel
  const recipient = recipientFor(channel, row.contact)
  // The contact's zone, or their company's. Never the sender's, and never
  // derived from a country (§2.1; see 0010).
  const zoneFrom = row.contact.timeZone ? 'contact' : row.companyTimeZone ? 'company' : null

  // The suppression lookup, over EVERY key this recipient matches — an email
  // is suppressed by its address and by its domain. `suppressionKeysFor`
  // builds them so no caller has to remember the second one. Run for a
  // paused contact too: it used to be skipped there, so a paused AND
  // suppressed person read as "not suppressed" on every preview and was
  // logged as a revoked consent rather than as the opt-out. Found by review.
  const suppressed = await anySuppressionMatches(db, orgId, suppressionKeysFor(recipient, channel) ?? [])

  const consentRows = await db
    .select({ granted: schema.consents.granted, source: schema.consents.source })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.contactId, contactId),
        eq(schema.consents.channel, channel),
        eq(schema.consents.orgId, orgId),
      ),
    )
    .limit(1)
  const consentRecorded = consentRows[0] ?? null

  // The cap is per campaign per DAY, counted from rows that actually went.
  // Counted in the database rather than tracked in a column: a counter is a
  // second source of truth that drifts, and the drift always favours sending.
  const startOfDay = new Date(now)
  startOfDay.setUTCHours(0, 0, 0, 0)
  const sentTodayRows = await db
    .select({ n: count() })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.campaignId, campaignId),
        eq(schema.touches.direction, 'out'),
        isNotNull(schema.touches.sentAt),
        gte(schema.touches.sentAt, startOfDay),
      ),
    )

  // r4 (review round 3, finding 4): aged OR superseded. The words quote one
  // scan; a newer successful scan of the company may say a gap they name is
  // closed, and only the latest is quoted in anything outbound — the rule
  // `quotableFindings` and the share link keep, which the sender did not.
  const evidence =
    args.evidenceAsOf === null
      ? { aged: false, superseded: false }
      : await evidenceState(db, orgId, row.contact.companyId, args.evidenceAsOf, now)

  /**
   * A paused contact — they replied, a teammate is holding them, or an
   * opt-out or an erasure could not be completed. Its own fact, and the
   * consent fact is the row as recorded, exactly as for anybody else. It
   * used to be modelled as a revoked consent, so a teammate's hold was
   * refused `consent_revoked` — the recipient's own no — and enrolment read
   * it that way for ever after the hold was lifted. Found by review. Every
   * other fact is gathered as for anyone, so `decideSend` orders the
   * refusals: a suppression and a recorded refusal still outrank the pause.
   * The reason goes to `decideSend` as its CLASS only; its text can carry a
   * teammate's address and the contact's words.
   */
  const paused = row.contact.pausedAt !== null
  const pausedReason = paused ? row.contact.pausedReason ?? 'paused' : null
  // Review round 10, [2]: one read, for a paused contact only — and only
  // for a pause Resume asks the question about (review round 11).
  const sharedNumberHold =
    paused && resumeAsksSharedNumber(row.contact.pausedReason) && (await heldForUnrecordedSharedNumber(db, orgId, row.contact))

  // 0019: the registered template behind THESE words, on SMS and WhatsApp.
  // The caller's words, else the stored message the evidence question names.
  let words: MessageWords | null = args.words ?? null
  if (!words && TEMPLATE_CHANNELS.has(channel) && args.evidenceAsOf !== null && !(args.evidenceAsOf instanceof Date)) {
    const [stored] = await db
      .select({ templateId: schema.touches.templateId, body: schema.touches.body })
      .from(schema.touches)
      .where(and(eq(schema.touches.id, args.evidenceAsOf.touchId), eq(schema.touches.orgId, orgId)))
      .limit(1)
    words = stored ?? null
  }
  const template = TEMPLATE_CHANNELS.has(channel) ? await templateFactsFor(db, orgId, channel, words) : null

  return {
    recipient,
    zoneFrom,
    wordsKnown: !TEMPLATE_CHANNELS.has(channel) || words !== null,
    paused,
    pausedReason,
    consentRecorded,
    campaignChannel,
    evidenceAged: evidence.aged,
    evidenceSuperseded: evidence.superseded,
    sharedNumberHold,
    facts: {
      channel,
      recipient,
      suppressed,
      /**
       * A permanent bounce is about the EMAIL address, so it refuses email and
       * nothing else: the person may still be reachable on LinkedIn. The mark
       * is cleared by correcting the address (`contactsUpdate`), which is the
       * only thing that could make the next message land.
       */
      recipientBounced: channel === 'email' && row.contact.emailBouncedAt !== null,
      consent: consentRecorded,
      paused,
      ...(paused ? { pausedFor: pauseReasonClass(row.contact.pausedReason) } : {}),
      evidenceStale: evidence.aged || evidence.superseded,
      template,
      recipientTimeZone: row.contact.timeZone ?? row.companyTimeZone ?? null,
      quietStart: row.campaign.quietStart,
      quietEnd: row.campaign.quietEnd,
      sentToday: sentTodayRows[0]?.n ?? 0,
      dailyCap: row.campaign.dailyCap,
      autoSend: row.campaign.autoSend,
      campaignStatus: row.campaign.status as SendFacts['campaignStatus'],
      approvedByHuman: args.approvedByHuman,
      now,
    },
  }
}

/**
 * Whether the evidence words written at `writtenAt` could have quoted is
 * past its re-verification deadline at `now` (`aged`), or has been
 * superseded by a newer SUCCESSFUL scan of the company (`superseded`) —
 * §2.2, each a reason the words are no longer known to be true.
 *
 * The evidence is the latest `ok` scan of the company at or before the
 * moment of writing; with none, no scan could have been quoted, and there
 * is nothing to be stale or superseded. The threshold is the active ICP's
 * `freshness.stale_after_days`, read the way every other reader of it does
 * — `staleAfterDaysOf`, which gives §2.2's default when there is no profile,
 * it will not parse, or the value is not a positive number (`isStale` throws
 * on one, and a bad ICP value must not stop the sender).
 *
 * For a stored message the moment is the row's own `created_at`, read in
 * the same statement — `complianceDraftsOnStaleEvidence`'s predicate, so the
 * count and the sender cannot disagree about which scan the words quote.
 * The `Date` beside the id is the fallback only for a row that is gone by
 * the time this runs (another org's id included), which is the moment the
 * caller last read it as.
 *
 * Superseded (r4, review round 3, finding 4) is asked in the SAME statement,
 * against that scan's STORED `ran_at` and with the scan excluded by id —
 * never against its `ran_at` read back as a millisecond `Date`, which
 * matched the scan itself and made every proposal superseded by its own
 * scan (`scanSuperseded` in proposal-shares.ts, round 2). A newer scan that
 * did not reach the site observed nothing and supersedes nothing. The outer
 * table is named `scans` in the raw SQL on purpose: an unqualified column
 * inside the subquery would bind to `newer`.
 */
async function evidenceState(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  writtenAt: StoredWords | Date,
  now: Date,
): Promise<{ readonly aged: boolean; readonly superseded: boolean }> {
  const atOrBefore =
    writtenAt instanceof Date
      ? lte(schema.scans.ranAt, writtenAt)
      : sql`${schema.scans.ranAt} <= coalesce(
          (SELECT t.created_at FROM touches t WHERE t.id = ${writtenAt.touchId}::uuid AND t.org_id = ${orgId}::uuid),
          ${writtenAt.writtenAt.toISOString()}::timestamptz
        )`
  const [scan] = await db
    .select({
      ranAt: schema.scans.ranAt,
      superseded: sql<boolean>`EXISTS (
        SELECT 1 FROM scans newer
         WHERE newer.org_id = scans.org_id AND newer.company_id = scans.company_id
           AND newer.ok AND newer.id <> scans.id AND newer.ran_at > scans.ran_at
      )`,
    })
    .from(schema.scans)
    .where(
      and(
        eq(schema.scans.orgId, orgId),
        eq(schema.scans.companyId, companyId),
        eq(schema.scans.ok, true),
        atOrBefore,
      ),
    )
    .orderBy(desc(schema.scans.ranAt))
    .limit(1)
  if (!scan) return { aged: false, superseded: false }
  return { aged: isStale(scan.ranAt, await staleAfterDays(db, orgId), now), superseded: scan.superseded === true }
}

/**
 * `decideSend` over gathered facts, with a `stale_evidence` refusal worded
 * for what made the words stale (r4, review round 3, finding 4).
 *
 * `decideSend` knows one evidence fact, `evidenceStale`, and words it as a
 * scan past its deadline. Words quoting a scan a newer one has superseded
 * are refused with the same code — nobody may approve past it, and a new
 * draft from the latest scan resolves it, exactly as for aged evidence —
 * but "past its re-verification deadline" would be false about a scan three
 * days old, so the sentence says what happened. Aged AND superseded keeps
 * the deadline sentence, the plainer of two true reasons. The sender and
 * every dry run (`previewSend`) decide through this, so they cannot word
 * one refusal two ways.
 *
 * And a `paused` refusal of a shared number's holder whose own pause stood
 * (`sharedNumberHold`, review round 10, [2]): `pausedSentence` words the
 * pause by its class — "until a person resumes them there" for a teammate's
 * — while Resume refuses it until the number is recorded. The sentence says
 * so after the class's own. Not for the classes whose sentence already says
 * to record something rather than resume (an unrecorded opt-out, the
 * shared-number hold's own shape among them) or to finish an erasure.
 */
export function decideGathered(gathered: {
  readonly facts: SendFacts
  readonly evidenceAged: boolean
  readonly evidenceSuperseded: boolean
  readonly sharedNumberHold?: boolean
}): SendDecision {
  const decision = decideSend(gathered.facts)
  if (!decision.allowed && decision.code === 'paused') {
    const pausedFor = gathered.facts.pausedFor ?? 'other'
    if (!gathered.sharedNumberHold || pausedFor === 'opt_out_not_recorded' || pausedFor === 'erasure') return decision
    return { ...decision, reason: `${decision.reason} ${SHARED_NUMBER_HOLD_SENTENCE}` }
  }
  if (decision.allowed || decision.code !== 'stale_evidence') return decision
  if (gathered.evidenceAged || !gathered.evidenceSuperseded) return decision
  return {
    ...decision,
    reason:
      'A newer scan of this company has reached the site since the scan these words quote, and only the ' +
      'latest successful scan is quoted in anything outbound (§2.2), so what they say may no longer be ' +
      'true. Nothing was sent, and approving does not make them current. Draft the message again from ' +
      'the latest scan.',
  }
}

/**
 * What `decideGathered` adds to a `paused` refusal of a shared number's
 * holder whose own pause stood (review round 10, [2]). It never says they
 * asked — they may have sent nothing — and names what Resume waits for.
 */
export const SHARED_NUMBER_HOLD_SENTENCE =
  'A text from a number they share also asked to stop, and it could not be recorded — they may not have sent it — ' +
  'so Resume is refused until the number is recorded on /suppressions.'

async function staleAfterDays(db: AgencyDb, orgId: string): Promise<number> {
  return staleAfterDaysOf((await activeIcpProfile(db, orgId))?.definition)
}

/**
 * The channel of the stored message `evidenceAsOf` names (r4), or null for
 * words nobody has stored — a `Date`, an answer to a reply (`null`), or a
 * row that is gone (another org's id included). So a screen previewing a
 * stored draft asks about the channel the sender will send it on.
 */
async function storedChannel(db: AgencyDb, orgId: string, evidenceAsOf: EvidenceAsOf): Promise<Channel | null> {
  if (evidenceAsOf === null || evidenceAsOf instanceof Date) return null
  const [row] = await db
    .select({ channel: schema.touches.channel })
    .from(schema.touches)
    .where(and(eq(schema.touches.id, evidenceAsOf.touchId), eq(schema.touches.orgId, orgId)))
    .limit(1)
  return (row?.channel as Channel | undefined) ?? null
}

/** Where a message on this channel is addressed. */
function recipientFor(channel: Channel, contact: typeof schema.contacts.$inferSelect): string {
  switch (channel) {
    case 'email':
      return contact.email ?? ''
    case 'linkedin':
      return contact.linkedinUrl ?? ''
    case 'sms':
    case 'voice':
    case 'whatsapp':
      return contact.phone ?? ''
    default:
      // An unknown channel has no address, so the send path refuses it as an
      // unparseable recipient rather than guessing at a column.
      return ''
  }
}

// ---------------------------------------------------------------------------
// A person decides on a draft (§2.4)
// ---------------------------------------------------------------------------

/** Drafts waiting for a person, oldest first, with what they are about. */
export async function pendingDrafts(
  db: AgencyDb,
  orgId: string,
  limit = 100,
): Promise<
  Array<{
    touch: TouchRow
    company: { id: string; domain: string; name: string | null } | null
    contact: { id: string; email: string | null; firstName: string | null; lastName: string | null } | null
  }>
> {
  const rows = await db
    .select({
      touch: schema.touches,
      companyId: schema.companies.id,
      companyDomain: schema.companies.domain,
      companyName: schema.companies.name,
      contactId: schema.contacts.id,
      contactEmail: schema.contacts.email,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
    })
    .from(schema.touches)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.touches.contactId))
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.status, 'awaiting_approval'),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))
    .limit(limit)
  return rows.map((r) => ({
    touch: r.touch,
    company: r.companyId ? { id: r.companyId, domain: r.companyDomain ?? '', name: r.companyName ?? null } : null,
    contact: r.contactId
      ? { id: r.contactId, email: r.contactEmail ?? null, firstName: r.contactFirst ?? null, lastName: r.contactLast ?? null }
      : null,
  }))
}

export type DraftDecision =
  | { readonly ok: true; readonly touch: TouchRow }
  | {
      readonly ok: false
      readonly reason:
        | 'not_found'
        | 'already_decided'
        | 'no_such_contact'
        | 'no_such_campaign'
        | 'wrong_company'
        | 'wrong_channel'
        | 'rendered_for_another'
    }

/**
 * Approve a draft: name the recipient, the campaign, and yourself.
 *
 * One UPDATE with `status = 'awaiting_approval'` in the predicate, so two
 * people approving at once produce exactly one approval — the same
 * arbitration `decideApproval` uses. The recipient and campaign are set HERE,
 * not by the agent: a draft from chat has neither (Phase 2 had no contacts),
 * and the person approving is the right one to choose.
 *
 * Approving does not send. It marks the row `approved`, and the worker's next
 * tick runs it through every §2.1 rule and then the provider. That is
 * deliberate: the person approved the words, and the rules are re-checked at
 * the moment of sending, not the moment of reading.
 */
export async function approveDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly contactId: string
    readonly campaignId: string
    readonly approvedBy: string
    readonly note?: string | null
    readonly now?: Date
  },
): Promise<DraftDecision> {
  const touchRows = await db
    .select()
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, args.orgId), eq(schema.touches.id, args.touchId)))
    .limit(1)
  const touch = touchRows[0]
  if (!touch) return { ok: false, reason: 'not_found' }
  if (touch.status !== 'awaiting_approval') return { ok: false, reason: 'already_decided' }

  const contactRows = await db
    .select({ id: schema.contacts.id, companyId: schema.contacts.companyId })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
    .limit(1)
  const contact = contactRows[0]
  if (!contact) return { ok: false, reason: 'no_such_contact' }

  // A draft written about one company must not be approved to a person at
  // another. The draft quotes that company's findings (§2.2), and sending it
  // elsewhere is a claim about the wrong company.
  if (touch.companyId && contact.companyId !== touch.companyId) {
    return { ok: false, reason: 'wrong_company' }
  }

  // On SMS and WhatsApp the words are a registered template with each slot
  // filled FOR ONE PERSON — their name, their meeting — and the row names
  // them. The approver chooses the recipient of an email draft (one from
  // chat is written to nobody); here the choice was made when the body was
  // rendered, and approving it to a colleague sends them a text that greets
  // somebody else. /approvals offers only that person, but a direct call to
  // the route does not go through its list. A row whose contact is gone
  // (NULL) was rendered for somebody too, and may go to nobody.
  if (TEMPLATE_CHANNELS.has(touch.channel as Channel) && touch.contactId !== contact.id) {
    return { ok: false, reason: 'rendered_for_another' }
  }

  const campaignRows = await db
    .select({ id: schema.campaigns.id, channel: schema.campaigns.channel })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, args.orgId), eq(schema.campaigns.id, args.campaignId)))
    .limit(1)
  const campaign = campaignRows[0]
  if (!campaign) return { ok: false, reason: 'no_such_campaign' }

  // A LinkedIn draft approved under an email campaign is not "an email now"
  // — it is a message written for one medium sent through another. Found by
  // review: the row's channel used to be silently rewritten to the campaign's.
  if (campaign.channel !== touch.channel) return { ok: false, reason: 'wrong_channel' }

  const updated = await db
    .update(schema.touches)
    .set({
      status: 'approved',
      contactId: contact.id,
      companyId: touch.companyId ?? contact.companyId,
      campaignId: campaign.id,
      channel: campaign.channel,
      approvedBy: args.approvedBy,
      approvedAt: args.now ?? new Date(),
      decisionNote: args.note?.trim() || null,
    })
    .where(
      and(
        eq(schema.touches.id, touch.id),
        eq(schema.touches.orgId, args.orgId),
        eq(schema.touches.status, 'awaiting_approval'),
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.approvedBy} AND u.org_id = ${args.orgId})`,
      ),
    )
    .returning()
  const row = updated[0]
  if (!row) return { ok: false, reason: 'already_decided' }

  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.approvedBy,
    action: 'draft.approved',
    subjectType: 'touch',
    subjectId: row.id,
    detail: { contactId: contact.id, campaignId: campaign.id, channel: campaign.channel },
  }).catch(() => {})
  return { ok: true, touch: row }
}

/**
 * Deny a draft. The reason is recorded on the row: a draft denied with no note
 * is one the agent will rewrite the same way.
 *
 * The refusal code says WHOSE no it was. Usually a person's
 * (`needs_approval`), which enrolment reads as a no and never drafts past.
 * But a draft whose own words the sender would refuse as `stale_evidence` —
 * judged as the sender judges it, at the moment the words were written
 * (`evidenceAsOfFor`) — is denied because the evidence aged out, and
 * /approvals tells the person exactly that: deny it, re-scan, draft again.
 * Recorded as `needs_approval`, that advice was a dead end: the re-scan
 * happened and enrolment still skipped them as already contacted, for good.
 * Found by review. So it is recorded as `stale_evidence`, a refusal a re-scan
 * resolves, and the audit row names the code.
 *
 * Denying an ANSWER to a reply also puts back the pause the reply caused,
 * when drafting that answer is what lifted it (`repauseForUnansweredReply`,
 * review round 3): the reply is unanswered again, and a person whose reply
 * nobody answered is not somebody every campaign may write to.
 */
export async function denyDraft(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly touchId: string
    readonly decidedBy: string
    readonly note?: string | null
    /** Injectable for tests; the moment the staleness is judged at. */
    readonly now?: Date
  },
): Promise<DraftDecision> {
  const now = args.now ?? new Date()
  const refusalCode = await denialCode(db, args.orgId, args.touchId, now)
  // One transaction (review round 3): the deny, and for an answer to a reply
  // the pause it puts back (`repauseForUnansweredReply`), land together or not
  // at all. The `draft.denied` row below stays outside it, caught as before:
  // a caught failure INSIDE a transaction would leave it aborted, and its
  // COMMIT would roll back the deny without a word.
  const row = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as AgencyDb
    // Contact before touch (review round 5, [13]). A reply, a bounce and a
    // reclassify lock the person and then cancel their waiting messages —
    // this answer among them; the deny locked the answer and then, to put
    // the pause back, the person, and the two could deadlock on a real
    // Postgres. So an answer's deny takes the reply's contact first, the
    // lock `repauseForUnansweredReply` then re-takes. A read, not a lock, of
    // the answer row: it is locked by the UPDATE below, after the person.
    const [draft] = await tx
      .select({ answersTouchId: schema.touches.answersTouchId })
      .from(schema.touches)
      .where(and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId)))
      .limit(1)
    if (draft?.answersTouchId) await lockReplyContact(tx, args.orgId, draft.answersTouchId)
    const updated = await tx
      .update(schema.touches)
      .set({
        status: 'refused',
        refusalCode,
        decisionNote: args.note?.trim() || 'denied',
      })
      .where(
        and(
          eq(schema.touches.id, args.touchId),
          eq(schema.touches.orgId, args.orgId),
          eq(schema.touches.status, 'awaiting_approval'),
          sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${args.decidedBy} AND u.org_id = ${args.orgId})`,
        ),
      )
      .returning()
    const denied = updated[0]
    if (denied?.answersTouchId) {
      await repauseForUnansweredReply(tx, { orgId: args.orgId, answer: denied, actor: args.decidedBy, because: 'denied', now })
    }
    return denied
  })
  if (!row) {
    const current = await db
      .select({ status: schema.touches.status })
      .from(schema.touches)
      .where(and(eq(schema.touches.id, args.touchId), eq(schema.touches.orgId, args.orgId)))
      .limit(1)
    return { ok: false, reason: current[0] ? 'already_decided' : 'not_found' }
  }
  await appendAudit(db, {
    orgId: args.orgId,
    actor: args.decidedBy,
    action: 'draft.denied',
    subjectType: 'touch',
    subjectId: row.id,
    // `refusalCode` is `stale_evidence` when the draft was denied on words
    // quoting a scan that had aged out, and `needs_approval` otherwise.
    detail: { note: row.decisionNote, refusalCode: row.refusalCode },
  }).catch(() => {})
  return { ok: true, touch: row }
}

/**
 * How an answer to a reply ended without going, in the words its re-pause
 * is recorded with. `denied` is a person's no on /approvals; `failed` the
 * provider's; `refused` the send path's at the moment of sending; `bounced`
 * a delivery report's cancel of everything still waiting for that address.
 */
export type AnswerEnded = 'denied' | 'failed' | 'refused' | 'bounced'

/**
 * Whether settling an answer in this state leaves its reply unanswered — and
 * how — or null when it does not (review round 4).
 *
 * `failed` always: the provider did not take it, and nothing retries a
 * failed row. `refused` for good, with two exceptions. A deferral the clock
 * resolves (`REFUSALS_THE_CLOCK_RESOLVES`: quiet hours, the cap, a paused
 * campaign) is not an ending — the sender's tick and the LinkedIn step put
 * that row back `approved` with `scheduled_for`, and a pause written here
 * would refuse it when it came round again. And `suppressed`: the person is
 * on the list, which is the stronger statement, and the writer that put
 * them there — an unsubscribe, a reply that said stop — pauses them itself
 * with its own reason, after the suppression row. A `replied` pause landing
 * between those two writes would be kept by that writer's idempotent pause,
 * and an opt-out would read as a reply waiting for an answer.
 */
export function answerEndedBy(status: string, refusalCode: string | null): AnswerEnded | null {
  if (status === 'failed') return 'failed'
  if (status !== 'refused') return null
  if (refusalCode !== null && REFUSALS_THE_CLOCK_RESOLVES.has(refusalCode)) return null
  if (refusalCode === 'suppressed') return null
  return 'refused'
}

/** What the re-pause's audit row says, by how the answer ended. Under 80 characters: /audit quotes it. */
const UNANSWERED_AGAIN: Record<Exclude<AnswerEnded, 'denied'>, string> = {
  failed: 'their reply is unanswered again: the answer to it failed to send',
  refused: 'their reply is unanswered again: the answer to it was refused at sending',
  bounced: 'their reply is unanswered again: the answer to it was cancelled by a bounce',
}

/**
 * The reason a reply's own pause carries, `replied <instant>` — the shape
 * `pauseReasonClass` reads as `replied`. One spelling, for the re-pause that
 * puts it back and the lift that takes the re-pause off again.
 */
function replyPauseReason(reply: { readonly sentAt: Date | null; readonly createdAt: Date }): string {
  return `replied ${(reply.sentAt ?? reply.createdAt).toISOString()}`
}

/**
 * Lock the contact a reply came from, `FOR UPDATE`, and return its id — or
 * null when the reply or the contact is gone. Taken FIRST by every writer
 * here that settles an answer and then pauses or resumes its person (review
 * round 5, [13]): contact before touch, the order a reply, a bounce, a
 * reclassify and an erasure take, so no two of them can each hold the
 * lock the other waits for.
 */
async function lockReplyContact(db: AgencyDb, orgId: string, replyTouchId: string): Promise<string | null> {
  const [reply] = await db
    .select({ contactId: schema.touches.contactId })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.id, replyTouchId),
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'in'),
      ),
    )
    .limit(1)
  if (!reply?.contactId) return null
  const [contact] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, reply.contactId), eq(schema.contacts.orgId, orgId)))
    .limit(1)
    .for('update')
  return contact?.id ?? null
}

/**
 * `lockReplyContact` for several answers at once — the stuck-send recovery's
 * (apps/agent/src/boot/reconcile.ts), which settles every claim the last
 * worker left and re-pauses the people whose answers were among them
 * (review round 6, [13]). Each reply is read, never locked; their contacts
 * are then locked `FOR UPDATE` in ONE statement, in id order — Postgres
 * applies ORDER BY before the locking clause, so the rows are locked in
 * that order and two writers holding several people cannot each wait on
 * the other. Call it BEFORE writing any of the answers: contact before
 * touch. A reply or a contact that is gone is skipped, as the single
 * helper returns null for it.
 */
export async function lockReplyContacts(
  db: AgencyDb,
  answers: readonly { readonly orgId: string; readonly answersTouchId: string }[],
): Promise<void> {
  if (answers.length === 0) return
  const replies = await db
    .select({ id: schema.touches.id, orgId: schema.touches.orgId, contactId: schema.touches.contactId })
    .from(schema.touches)
    .where(
      and(
        inArray(schema.touches.id, [...new Set(answers.map((a) => a.answersTouchId))]),
        eq(schema.touches.direction, 'in'),
        isNotNull(schema.touches.contactId),
      ),
    )
  // Only a reply in the answer's own org names a person to lock.
  const wanted = new Set(answers.map((a) => `${a.orgId}:${a.answersTouchId}`))
  const contactIds = [
    ...new Set(replies.filter((r) => wanted.has(`${r.orgId}:${r.id}`) && r.contactId).map((r) => r.contactId as string)),
  ]
  if (contactIds.length === 0) return
  await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(inArray(schema.contacts.id, contactIds))
    .orderBy(asc(schema.contacts.id))
    .for('update')
}

/**
 * Put back the pause a reply caused when the answer that lifted it never
 * goes (review rounds 3 and 4).
 *
 * The inbox resumes a person when an answer to their reply is DRAFTED
 * (`replyQueueDraft`, inbox.ts) — /approvals would otherwise refuse the
 * answer itself as `paused`. An answer that is then denied, fails at the
 * provider, is refused for good at sending, or is cancelled by a bounce
 * leaves the reply unanswered, and before this every campaign was live for
 * them again: a cold opener in another campaign read "nothing stops it"
 * over a reply nobody had answered. Round 3 covered the deny alone; every
 * writer that settles an answer `failed` or `refused` now calls this, in
 * its own transaction, so the settle and the pause land together or not at
 * all — `settle` for each of `dispatchTouch`'s, `denyDraft`, and the
 * bounce's cancel (`outreachRecordBounce`). Exported for the one writer
 * outside this file that settles an answer `failed`: the stuck-send
 * recovery (`recoverStuckSends`). The LinkedIn step's "I did not send it"
 * never calls it, and needs not: an answer is only ever email — no inbound
 * LinkedIn path exists, and the inbox refuses SMS and WhatsApp. When the
 * recovery guessed wrong and the provider had taken the answer after all,
 * `dispatchTouch` lifts the pause put back here (`liftRecoveryPause`).
 *
 * The pause goes back on, with the reply's own `replied <instant>` reason —
 * the shape `recordInboundReply` writes and `pauseReasonClass` reads — when:
 *
 *  - this answer is what resumed them (`reply.answer_drafted` says
 *    `resumed: true`);
 *  - nobody has resumed them since (no later `contact.resumed` row,
 *    compared in SQL by id: a `Date` holds milliseconds and the column
 *    microseconds, and the inbox's own resume row shares the draft's
 *    instant) — a person's own Resume on /contacts stands. That row is
 *    written in the resume's own transaction (`contactResumeByHand`, round
 *    4), and the contact is LOCKED before the log is read, so a resume in
 *    flight is waited for and then seen;
 *  - no other answer of theirs is still on its way, which will answer them.
 *
 * The contact is the REPLY's — the person drafting the answer resumed — not
 * whatever the answer row names now. `pauseContact` keeps any pause they
 * have now: a teammate's hold, an unsubscribe's, an unrecorded opt-out's or
 * an unfinished erasure's is never replaced by `replied`.
 *
 * Returns whether it paused them. Never `.catch`-ed by a caller: a pause
 * nobody can see in the log is one nobody can explain, and a fault here
 * rolls back the settle beside it rather than leaving a settled answer and
 * a resumed person with no record of why.
 */
export async function repauseForUnansweredReply(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly answer: Pick<TouchRow, 'id' | 'answersTouchId'>
    /** A user id for a deny; `system` for everything the send path settles. */
    readonly actor: string
    readonly because: AnswerEnded
    readonly now: Date
  },
): Promise<boolean> {
  const { orgId, answer } = args
  if (!answer.answersTouchId) return false
  const [reply] = await db
    .select({ contactId: schema.touches.contactId, sentAt: schema.touches.sentAt, createdAt: schema.touches.createdAt })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.id, answer.answersTouchId),
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.direction, 'in'),
      ),
    )
    .limit(1)
  const contactId = reply?.contactId
  if (!reply || !contactId) return false

  // Locked first (review round 4): a /contacts resume in flight holds this
  // row until its audit row commits beside it, and the reads below then see
  // that row. Already paused, there is nothing to put back.
  const [contact] = await db
    .select({ pausedAt: schema.contacts.pausedAt })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)))
    .limit(1)
    .for('update')
  if (!contact || contact.pausedAt) return false

  const [drafted] = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'reply.answer_drafted'),
        sql`${schema.auditLog.detail}->>'touchId' = ${answer.id}`,
        sql`${schema.auditLog.detail}->>'resumed' = 'true'`,
      ),
    )
    .limit(1)
  if (!drafted) return false

  const resumedSince = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, orgId),
        eq(schema.auditLog.action, 'contact.resumed'),
        eq(schema.auditLog.subjectType, 'contact'),
        eq(schema.auditLog.subjectId, contactId),
        sql`${schema.auditLog.createdAt} > (SELECT a.created_at FROM audit_log a WHERE a.id = ${drafted.id})`,
      ),
    )
    .limit(1)
  if (resumedSince.length > 0) return false

  const otherAnswer = await db
    .select({ id: schema.touches.id })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.contactId, contactId),
        eq(schema.touches.direction, 'out'),
        isNotNull(schema.touches.answersTouchId),
        inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved', 'sending']),
        sql`${schema.touches.id} <> ${answer.id}`,
      ),
    )
    .limit(1)
  if (otherAnswer.length > 0) return false

  const paused = await pauseContact(db, orgId, contactId, replyPauseReason(reply), args.now)
  if (!paused) return false
  // Uncaught, inside the settle's transaction. A deny keeps the shape /audit
  // words as "the answer to their reply was denied"; every other ending is
  // quoted from its own `reason`, and names the answer rather than the reply
  // — that sentence keys on `inboundTouchId` and would call a failure a deny.
  await appendAudit(db, {
    orgId,
    actor: args.actor,
    action: 'contact.paused',
    subjectType: 'contact',
    subjectId: contactId,
    detail:
      args.because === 'denied'
        ? {
            reason: 'their reply is unanswered again: the answer to it was denied',
            alreadyPaused: false,
            inboundTouchId: answer.answersTouchId,
          }
        : { reason: UNANSWERED_AGAIN[args.because], alreadyPaused: false, answerTouchId: answer.id, answerEnded: args.because },
  })
  return true
}

/**
 * What denying this draft records: `stale_evidence` when the sender's own
 * answer about its words — the facts `previewSend` would gather, at the
 * draft's written-at moment — is that refusal, and a person's
 * `needs_approval` otherwise. That includes a draft that cannot be checked
 * (no contact or campaign yet), and one refused for anything else first: a
 * suppression, a recorded refusal or a pause outranks the evidence, and a
 * person's no beside it is the safe record. An answer to a reply quotes no
 * scan (`evidenceAsOfFor` is null), so it is never denied as stale.
 */
async function denialCode(
  db: AgencyDb,
  orgId: string,
  touchId: string,
  now: Date,
): Promise<'needs_approval' | 'stale_evidence'> {
  const [draft] = await db
    .select({
      id: schema.touches.id,
      contactId: schema.touches.contactId,
      campaignId: schema.touches.campaignId,
      createdAt: schema.touches.createdAt,
      answersTouchId: schema.touches.answersTouchId,
      templateId: schema.touches.templateId,
      body: schema.touches.body,
    })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.id, touchId),
        eq(schema.touches.orgId, orgId),
        eq(schema.touches.status, 'awaiting_approval'),
      ),
    )
    .limit(1)
  if (!draft?.contactId || !draft.campaignId) return 'needs_approval'
  const gathered = await sendFactsFor(db, {
    orgId,
    campaignId: draft.campaignId,
    contactId: draft.contactId,
    approvedByHuman: true,
    evidenceAsOf: evidenceAsOfFor(draft),
    words: { templateId: draft.templateId, body: draft.body },
    now,
  })
  if ('missing' in gathered) return 'needs_approval'
  const decision = decideSend(gathered.facts)
  return !decision.allowed && decision.code === 'stale_evidence' ? 'stale_evidence' : 'needs_approval'
}

/**
 * What the worker's tick dispatches: approved and queued messages that are
 * due, oldest first, across every org.
 *
 * Bounded, because one campaign of a thousand must not monopolise a tick and
 * starve everyone else's — and because the per-campaign cap is enforced
 * inside `dispatchTouch`, the batch size here is about fairness, not about
 * volume.
 */
export async function dueTouches(
  db: AgencyDb,
  limit: number,
  now: Date = new Date(),
  /** The channels the caller's provider can carry. Others are left alone. */
  channels: readonly Channel[] = ['email'],
): Promise<TouchRow[]> {
  if (channels.length === 0) return []
  return db
    .select()
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.direction, 'out'),
        inArray(schema.touches.status, ['approved', 'queued']),
        inArray(schema.touches.channel, [...channels]),
        or(isNull(schema.touches.scheduledFor), lte(schema.touches.scheduledFor, now)),
      ),
    )
    .orderBy(asc(schema.touches.createdAt))
    .limit(limit)
}

// ---------------------------------------------------------------------------
// Replies (§8.4)
// ---------------------------------------------------------------------------

/**
 * Stop every sequence this contact is in (§8.4).
 *
 * "An inbound reply flips the deal to `replied` and pauses the sequence for
 * that contact immediately." One UPDATE on the contact, so it takes effect for
 * every campaign at once without anything having to enumerate them — and
 * before the next scheduled message can be picked up.
 *
 * Idempotent: a second reply must not overwrite the first reason with a later
 * one, because the first is the one that explains the pause.
 *
 * `replacing` (review round 3) is the one exception, and it names the reason
 * it may replace EXACTLY: a teammate's Pause on somebody a reply paused
 * (`contactPauseByHand`, inbox.ts). Kept, the reply's reason let answering
 * that reply resume them over the teammate's hold. The reason is in the
 * predicate, so a pause that changed since the caller read it — an opt-out
 * nobody could record, say — is never the one replaced.
 */
export async function pauseContact(
  db: AgencyDb,
  orgId: string,
  contactId: string,
  reason: string,
  now: Date = new Date(),
  opts: { readonly replacing?: string } = {},
): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: now, pausedReason: reason.slice(0, 500) })
    .where(
      and(
        eq(schema.contacts.orgId, orgId),
        eq(schema.contacts.id, contactId),
        opts.replacing === undefined
          ? sql`${schema.contacts.pausedAt} IS NULL`
          : or(sql`${schema.contacts.pausedAt} IS NULL`, eq(schema.contacts.pausedReason, opts.replacing)),
      ),
    )
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/**
 * Pause a contact with THIS reason, whether or not they were already paused.
 *
 * `pauseContact` keeps the first reason on purpose — a second reply must not
 * replace the one that explains the pause — and that is wrong in exactly one
 * kind of case: an opt-out that could not be recorded, or an erasure that
 * could not finish. That is the reason that matters now, and left behind an
 * older `replied …` it let answering that reply in /inbox resume a person who
 * had asked to stop (the inbox ends only a reply's own pause). The one
 * writer, shared by every path that knows an opt-out failed to store: a
 * reply's opt-out whose suppression failed (`recordInboundReply`, and
 * sms.ts for a number's other holders), a stop whose whole recording threw
 * (the two email webhooks, the DoveSoft text route and the worker's IMAP
 * inbox, through inbound-fault.ts's reason), a one-click unsubscribe that
 * could not be recorded (unsubscribe.ts), and an erasure rolled back whole
 * (erasure.ts). Each gives a reason `pauseReasonClass` reads as
 * `opt_out_not_recorded` or `erasure`.
 */
export async function pauseContactOverriding(
  db: AgencyDb,
  orgId: string,
  contactId: string,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: now, pausedReason: reason.slice(0, 500) })
    .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.id, contactId)))
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/**
 * Let a paused contact be contacted again — deliberately, by a person.
 *
 * `expectedReason` (review round 3) is the pause the caller READ and decided
 * to lift, in the UPDATE's own predicate: a string must still be the stored
 * reason, null must still be no reason. Without it the statement cleared
 * whatever the row held when it ran, so an "opt-out not recorded" pause
 * written between the inbox's read and its resume was wiped. Under READ
 * COMMITTED a concurrent writer that commits first makes the UPDATE
 * re-evaluate the row and match nothing, and the caller is told `false`.
 * With it, the row must also still BE paused (review round 4): null matched
 * a contact who was not paused at all, so a Resume on a stale tab answered
 * "resumed" and wrote a `contact.resumed` row for a resume that never
 * happened — a row `repauseForUnansweredReply` reads as a person's decision.
 * Omitted, the resume is unconditional, as it always was.
 */
export async function resumeContact(
  db: AgencyDb,
  orgId: string,
  contactId: string,
  opts: { readonly expectedReason?: string | null } = {},
): Promise<boolean> {
  const rows = await db
    .update(schema.contacts)
    .set({ pausedAt: null, pausedReason: null })
    .where(
      and(
        eq(schema.contacts.orgId, orgId),
        eq(schema.contacts.id, contactId),
        opts.expectedReason === undefined ? undefined : isNotNull(schema.contacts.pausedAt),
        opts.expectedReason === undefined
          ? undefined
          : opts.expectedReason === null
            ? isNull(schema.contacts.pausedReason)
            : eq(schema.contacts.pausedReason, opts.expectedReason),
      ),
    )
    .returning({ id: schema.contacts.id })
  return rows.length === 1
}

/**
 * Words that mean "stop", in a reply.
 *
 * Deliberately narrow: a whole short message, or a first line, that IS an
 * opt-out — not a message that merely contains the word "stop" somewhere in a
 * paragraph about their roadmap. A match adds a SUPPRESSION, which is the
 * strongest thing this system can do, so the bar is a clear statement. A
 * reply that is not clearly an opt-out still pauses the contact, so nothing
 * further goes to them either way; the difference is whether they can ever be
 * contacted again without a person removing a suppression. (The one reply
 * that does not pause is a genuine auto-reply, and "genuine" is decided by
 * the BROAD reader, `mentionsRemovalOrDeparture` — see `recordInboundReply`.)
 */
const LIST = String.raw`(?:your|the|this)\s+(?:(?:mailing|e-?mail(?:ing)?|contact)\s+)?list`
/**
 * The sentences above, whole. Review round 6 found "Please stop emailing me."
 * read as an ordinary reply — paused, never suppressed — so the commonest
 * ways to say it in a mail are listed: stop emailing / contacting / messaging
 * me, don't email me, remove or unsubscribe me from your list. Still a whole
 * first line (or a whole short message), with an optional please / kindly in
 * front and one please / thanks after, so "stop by", "stop the migration" and
 * a sentence that only mentions a list are not read.
 */
const OPT_OUT = new RegExp(
  String.raw`^\s*(?:(?:please|pls|kindly)[\s,]+)?(?:` +
    [
      String.raw`stop`,
      String.raw`stop\s+(?:e-?mailing|mailing|contacting|messaging|writing\s+to|spamming)(?:\s+me)?(?:\s+(?:again|any\s*more))?`,
      String.raw`stop\s+sending\s+(?:me\s+)?(?:e-?mails?|mails?|messages?)(?:\s+to\s+me)?`,
      String.raw`unsubscribe(?:\s+me)?(?:\s+from\s+${LIST})?`,
      String.raw`remove\s+me(?:\s+from\s+${LIST})?`,
      String.raw`opt(?:\s+me)?[\s-]?out(?:\s+of\s+${LIST})?`,
      String.raw`(?:do\s+not|don['’]?t)\s+(?:contact|e-?mail|message|mail)\s+me(?:\s+(?:again|any\s*more))?`,
      String.raw`no\s+more\s+e-?mails?`,
      String.raw`take\s+me\s+off\s+${LIST}`,
      String.raw`leave\s+me\s+alone`,
    ].join('|') +
    String.raw`)(?:[\s,.]+(?:please|pls|thanks|thank\s+you|thx))?[\s.!,]*$`,
  'i',
)

export function looksLikeOptOut(body: string | null | undefined): boolean {
  if (!body) return false
  // The person's own words: everything above a quoted reply. A quoted
  // "unsubscribe" link in the message they are replying to must not be read
  // as theirs. The same cut the broad reader makes.
  const own = ownWords(body)
  const first = own.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return OPT_OUT.test(first) || (own.trim().length <= 60 && OPT_OUT.test(own.trim()))
}

/**
 * Did a reply come FROM the contact it is filed under (review round 7)?
 *
 * Not always: `handleInboundEmail` files a reply matched by References under
 * the contact OUR message went to, whoever answered — and a colleague in
 * the thread replying all "please remove me from your list" is the opt-out
 * of the colleague, not of the contact. When it cannot be recorded, holding
 * the CONTACT as an opt-out nobody recorded locked out somebody who never
 * asked to stop, for good: no Resume lifts that pause, and the inbox reads
 * the audit row however old.
 *
 * Compared by the channel's own address key (`suppressionKeysFor`), never
 * the domain — a colleague shares it. False only when BOTH addresses read
 * and differ: a sender that is shown to be somebody else. Either side
 * unreadable — a contact whose address was cleared since — is true, the
 * reading that holds the contact as before, because "we could not tell"
 * is not "it was somebody else".
 */
export function replyIsFromTheContact(
  from: string | null,
  channel: Channel,
  contact: {
    readonly email: string | null
    readonly phone?: string | null
    readonly linkedinUrl?: string | null
  },
): boolean {
  const own = channel === 'email' ? contact.email : channel === 'linkedin' ? contact.linkedinUrl : contact.phone
  const sender = addressKeyOf(from, channel)
  const contactKey = addressKeyOf(own ?? null, channel)
  return sender === null || contactKey === null || sender === contactKey
}

/**
 * The one key an address is suppressed by on its channel — the address
 * itself, normalised (`suppressionKeysFor`), never the domain, which a
 * colleague shares. Null when it cannot be read. The comparison
 * `replyIsFromTheContact` makes, and the key `contactsAtTheAddress` finds
 * the sender by (review round 8).
 */
export function addressKeyOf(address: string | null | undefined, channel: Channel): string | null {
  return address ? (suppressionKeysFor(address, channel)?.find((k) => k.kind !== 'domain')?.value ?? null) : null
}

/**
 * The contacts of this org who ARE the sender of a reply filed under
 * somebody else (review round 8, [2]): those whose address key on the
 * channel is the From's (`addressKeyOf` — never the domain, which a
 * colleague shares), the filed contact excepted. Ordered by id, so two
 * writers holding several people take them in one order.
 *
 * Read by `recordInboundReply` beside the contact row, BEFORE anything that
 * may fail, so a reply rolled back by a fault still names them on its
 * rolled-back line — and the caller's loud path holds them by id, with
 * nothing read again from a database that just failed. In a savepoint: a
 * lookup that fails holds nobody and says so (`said`), and the reply still
 * records. LinkedIn has no inbound path, and no address here to compare.
 */
async function contactsAtTheAddress(
  tx: AgencyDb,
  args: { readonly orgId: string; readonly filedUnder: string; readonly channel: Channel; readonly from: string },
  said: (message: string, fields: Readonly<Record<string, unknown>>) => void,
): Promise<string[]> {
  const key = addressKeyOf(args.from, args.channel)
  if (key === null || args.channel === 'linkedin') return []
  try {
    const near = await tx.transaction((sp) =>
      (sp as unknown as AgencyDb)
        .select({ id: schema.contacts.id, email: schema.contacts.email, phone: schema.contacts.phone })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.orgId, args.orgId),
            sql`${schema.contacts.id} <> ${args.filedUnder}`,
            args.channel === 'email'
              ? sql`lower(btrim(${schema.contacts.email})) = ${key}`
              : sql`btrim(${schema.contacts.phone}) = ${key}`,
          ),
        )
        .orderBy(asc(schema.contacts.id)),
    )
    // The key the reply's own reading compares (`replyIsFromTheContact`),
    // in the same code: the SQL above only narrows.
    return near
      .filter((c) => addressKeyOf(args.channel === 'email' ? c.email : c.phone, args.channel) === key)
      .map((c) => c.id)
  } catch (err) {
    said('a stop from another address could not be matched to the contacts who hold it', {
      contactId: args.filedUnder,
      orgId: args.orgId,
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    return []
  }
}

/**
 * Hold everybody in this org who IS the sender of a stop that could not be
 * recorded, when the reply was filed under somebody else (review round 8,
 * [2]).
 *
 * `recordInboundReply` holds the contact a colleague's stop was filed under
 * only as any reply holds them (`replied <ISO>`), because the opt-out is the
 * SENDER's. And then nothing held the sender: a second contact here at the
 * address that asked to stop, with an approved message, was sent it on the
 * next tick — §2.1's "must never fall through to sending", broken for the
 * one person who asked. So each of them (`contactsAtTheAddress`) is held as
 * an opt-out nobody recorded, which is what it is:
 *
 *  - paused over any earlier reason (`pauseContactOverriding`, the reason
 *    every such path writes, class `opt_out_not_recorded`), which no Resume
 *    lifts and the inbox never ends;
 *  - their queued, awaiting-approval and approved messages refused
 *    `consent_revoked` — their own no, as a reply's cancel records it;
 *  - a `contact.opt_out_not_recorded` row with THEM as its subject — their
 *    own unrecorded opt-out, the shape the contact's own reply writes, which
 *    the inbox, Resume and /compliance read.
 *
 * Each write in its own savepoint, as every write in the reply's
 * transaction that may fail on its own is: a refused statement aborts a
 * transaction, and the reply must still commit. The contact before their
 * messages — the lock order every writer keeps. A write that fails is said
 * (`said`), once the reply is committed, and the others are still tried.
 * Returns how many were paused.
 */
async function holdTheSender(
  tx: AgencyDb,
  args: {
    readonly orgId: string
    readonly senders: readonly string[]
    readonly channel: Channel
    readonly touchId: string
    readonly why: string
    readonly now: Date
  },
  said: (message: string, fields: Readonly<Record<string, unknown>>) => void,
): Promise<number> {
  const failed = (step: string, contactId: string, err: unknown): void =>
    said('an opt-out that was not recorded could not hold the contact at the address that asked to stop', {
      touchId: args.touchId,
      contactId,
      orgId: args.orgId,
      step,
      error: err instanceof Error ? err.name : 'UnknownError',
    })

  let held = 0
  for (const contactId of args.senders) {
    try {
      const paused = await tx.transaction((sp) =>
        pauseContactOverriding(
          sp as unknown as AgencyDb, args.orgId, contactId,
          `opt-out not recorded: reply ${args.now.toISOString()} (${args.why})`, args.now,
        ),
      )
      if (paused) held++
    } catch (err) {
      failed('pause', contactId, err)
    }
    try {
      await tx.transaction((sp) =>
        (sp as unknown as AgencyDb)
          .update(schema.touches)
          .set({ status: 'refused', refusalCode: 'consent_revoked' })
          .where(
            and(
              eq(schema.touches.orgId, args.orgId),
              eq(schema.touches.contactId, contactId),
              eq(schema.touches.direction, 'out'),
              inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
            ),
          ),
      )
    } catch (err) {
      failed('cancel', contactId, err)
    }
    try {
      await tx.transaction((sp) =>
        appendAudit(sp as unknown as AgencyDb, {
          orgId: args.orgId,
          actor: 'system',
          action: 'contact.opt_out_not_recorded',
          subjectType: 'contact',
          subjectId: contactId,
          detail: { touchId: args.touchId, channel: args.channel, why: args.why },
        }),
      )
    } catch (err) {
      failed('audit', contactId, err)
    }
  }
  return held
}

/**
 * Record an inbound reply, and stop everything queued for that contact.
 *
 * Both halves in one call, because doing one without the other is the bug:
 * a logged reply that did not pause is a follow-up sent to somebody who
 * already answered.
 *
 * Also the deal: §8.4 says a reply flips it to `replied`, forward only. And
 * if the reply is an opt-out in so many words, the address goes on the
 * suppression list — the reply IS the opt-out, and recording it anywhere
 * weaker is a promise the send path does not keep.
 *
 * All of it is one transaction, so a fault leaves either the reply with
 * every consequence or nothing at all — and nothing is what a provider's
 * retry can complete (see the comment at the transaction).
 */
export async function recordInboundReply(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly channel: Channel
    readonly from: string
    readonly subject: string | null
    readonly body: string | null
    readonly providerId?: string | null
    readonly inReplyTo?: string | null
    /**
     * Whether the mail's HEADERS said it was automatic (Auto-Submitted,
     * Precedence: bulk — `readMailSignals` in packages/core decides it, and
     * `handleInboundEmail` passes it from every inbound path). The
     * PRECEDENCE is fixed here, not by the caller: the opt-out reader runs
     * first on every inbound, and only a body that did not ask to be left
     * alone may be filed as an auto-reply. See the comment at the
     * classification below.
     */
    readonly autoReply?: boolean
    /** See `InboundLog`. Defaults to a structured line on stderr. */
    readonly log?: InboundLog
    readonly now?: Date
  },
): Promise<{
  touchId: string
  paused: boolean
  cancelled: number
  suppressed: boolean
  /**
   * §2.1's Phase 4 obligation: true when the reply asked to be left alone
   * and the suppression row could NOT be written. Already audited and
   * logged by the time the caller sees it; the caller's job is to get a
   * person to record the opt-out by hand.
   */
  optOutNotRecorded: boolean
  /**
   * Whether the reply came from the contact it was filed under (review
   * round 7): false is a colleague's mail matched by our Message-ID, whose
   * opt-out is the SENDER's, so a caller's alarm must not name the contact.
   * Null when it could not be read.
   */
  fromIsContact: boolean | null
  deal: string | null
  /** The deterministic kind stored on the inbound touch (§5.5). */
  replyKind: ReplyKind
  /** The company the reply is about, for a caller's own notification. */
  companyId: string | null
  companyDomain: string | null
}> {
  const now = args.now ?? new Date()
  const log = args.log ?? stderrLog

  // Postgres refuses U+0000 in text, so a reply carrying one failed its
  // INSERT on every retry — on every channel, not only SMS (review round 5:
  // mailparser keeps a NUL decoded from quoted-printable `=00`, and IMAP,
  // Resend and the generic webhook all land here), and a "stop" sent that
  // way was recorded nowhere. Kept visible as U+FFFD rather than dropped, so
  // the stored words say a character was there; and the words READ are the
  // words stored. Here, once, for every caller — sms.ts' own strip before
  // it changes nothing.
  const withoutNul = <T extends string | null | undefined>(v: T): T =>
    (typeof v === 'string' ? v.replace(/\u0000/g, '\uFFFD') : v) as T
  const subject = withoutNul(args.subject)
  const body = withoutNul(args.body)
  const from = withoutNul(args.from)
  const providerId = withoutNul(args.providerId ?? null)

  /**
   * Classified from the SAME opt-out reading that decides the suppression
   * below, rather than a second look at the text. One reading, one answer:
   * a row that says `opted_out` and a suppression that was never written
   * would be two different claims about one reply.
   *
   * The ORDER is §2.1's, not the mail's. The opt-out reader runs FIRST on
   * every inbound; an auto-reply flag from the headers is consulted only
   * for a body that did not ask to be left alone. Only a GENUINE automatic
   * answer skips the pause, the cancel and the deal move: nobody read
   * anything, so nothing about the conversation changed.
   *
   * "Genuine" is decided by a second, BROAD reader. The narrow opt-out
   * reader is built to be sure before it writes a suppression, so it misses
   * "I have left — remove me from your list", "remove me from your list"
   * and an out-of-office ending "please remove me from your mailing list";
   * with only it, each of those skipped the pause while asking to be taken
   * off. Found by review. `mentionsRemovalOrDeparture` catches them and
   * makes the mail an ordinary reply — paused, queue cancelled, deal
   * advanced, as every inbound was before headers were read. It never
   * writes a suppression: that is still the narrow reader's alone.
   *
   * The deterministic kind is always stored, on the row's own INSERT. A
   * model may improve on it afterwards (§5.5) and can only ever move it
   * AMONG the non-opt-out kinds — `opted_out` is settled here, by a pure
   * function, before any model is consulted (§2.1).
   */
  // 0019: an SMS or WhatsApp reply is also read by the keyword reader its
  // footer taught (`smsOptOut`: STOP, STOP 56161, CANCEL alone, …); the
  // prose reader runs on every channel, as before.
  const optedOut =
    looksLikeOptOut(body) || ((args.channel === 'sms' || args.channel === 'whatsapp') && smsOptOut(body))
  const automatic = !optedOut && args.autoReply === true && !mentionsRemovalOrDeparture(body)
  const replyKind: ReplyKind = automatic ? 'auto_reply' : classifyReply(body, optedOut)

  /**
   * The reply and every consequence of it are ONE transaction: the row, the
   * pause, the cancel, the suppression attempt, the deal and the audit row.
   *
   * They were separate statements, the row committed first, and that is the
   * bug review round 3 found. A fault after the insert answered 500, the
   * provider retried — and the retry met `handleInboundEmail`'s Message-ID
   * dedupe, which answered `duplicate` and wrote nothing. A "Stop" was left
   * unclassified, unpaused and unsuppressed, its approved follow-up went on
   * the next tick, and no audit row or alarm said so. Now a fault rolls the
   * reply back with everything else, so the retry is not a duplicate and
   * records it all; and a stored row is one whose consequences were stored
   * with it, so a redelivery has nothing to finish.
   *
   * Three writes may fail on their OWN, as before — the suppression (whose
   * failure is the loud path below), the deal move and the audit rows — and
   * each runs in a savepoint (`tx.transaction`). That is not tidiness. A
   * statement the engine refuses ABORTS the transaction, and a COMMIT sent
   * to an aborted transaction is answered ROLLBACK with no error, which
   * drizzle resolves (measured on PGlite): a swallowed failure without a
   * savepoint would discard the whole reply while this function returned
   * its id. `inbound-atomic.test.ts` raises each fault in the engine.
   *
   * Everything inside uses `tx`, never `db`: on a pool of one connection
   * (Vercel's) a statement on `db` would wait for the connection this
   * transaction holds.
   */
  // Lines said once the outcome is COMMITTED: a line about a write that then
  // rolled back would be a claim about nothing.
  const said: { readonly message: string; readonly fields: Readonly<Record<string, unknown>> }[] = []
  // Whether the reply came from the contact it is filed under
  // (`replyIsFromTheContact`), from the contact row this transaction reads
  // first — kept out here so the rolled-back line can say it without
  // reading again from a database that just failed. Null when the fault
  // came before that read: unknown, which every reader holds as before.
  let fromIsContact: boolean | null = null
  // Whoever IS the sender of a stop filed under somebody else, when they are
  // contacts here (`contactsAtTheAddress`, review round 8): read beside the
  // contact, before anything that may fail, so the rolled-back line can
  // name them too and the caller holds them by id.
  let senders: string[] = []
  let recorded: Awaited<ReturnType<typeof recordInboundReply>>
  try {
    recorded = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as AgencyDb

      const contactRows = await tx
        .select({
          companyId: schema.contacts.companyId,
          companyDomain: schema.companies.domain,
          email: schema.contacts.email,
          phone: schema.contacts.phone,
          linkedinUrl: schema.contacts.linkedinUrl,
        })
        .from(schema.contacts)
        .leftJoin(schema.companies, eq(schema.companies.id, schema.contacts.companyId))
        .where(and(eq(schema.contacts.orgId, args.orgId), eq(schema.contacts.id, args.contactId)))
        .limit(1)
      const companyId = contactRows[0]?.companyId ?? null
      const companyDomain = contactRows[0]?.companyDomain ?? null
      if (contactRows[0]) fromIsContact = replyIsFromTheContact(from, args.channel, contactRows[0])
      if (optedOut && fromIsContact === false) {
        senders = await contactsAtTheAddress(
          tx,
          { orgId: args.orgId, filedUnder: args.contactId, channel: args.channel, from },
          (message, fields) => said.push({ message, fields }),
        )
      }

      const inserted = await tx
        .insert(schema.touches)
        .values({
          orgId: args.orgId,
          contactId: args.contactId,
          companyId,
          channel: args.channel,
          direction: 'in',
          status: 'replied',
          subject,
          body,
          recipient: from,
          providerId,
          inReplyTo: args.inReplyTo ?? null,
          replyKind,
          sentAt: now,
        })
        .returning({ id: schema.touches.id })
      const touchId = inserted[0]?.id
      if (!touchId) throw new Error('inbound touch insert returned no row')

      let paused = automatic
        ? false
        : await pauseContact(tx, args.orgId, args.contactId, `replied ${now.toISOString()}`, now)

      // Anything already queued for them is now wrong. Marked refused rather
      // than deleted: the record that it was ABOUT to go, and did not, is the
      // useful one.
      const cancelled = automatic
        ? []
        : await tx
            .update(schema.touches)
            .set({ status: 'refused', refusalCode: 'consent_revoked' })
            .where(
              and(
                eq(schema.touches.orgId, args.orgId),
                eq(schema.touches.contactId, args.contactId),
                eq(schema.touches.direction, 'out'),
                inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
              ),
            )
            .returning({ id: schema.touches.id })

      let suppressed = false
      let optOutNotRecorded = false
      // The key the reply came from: the address for email, the number for
      // SMS and WhatsApp (0019). Any other channel records no suppression here.
      const suppressionKind: SuppressionKind | null =
        args.channel === 'email' ? 'email' : args.channel === 'sms' || args.channel === 'whatsapp' ? 'phone' : null
      if (suppressionKind !== null && optedOut) {
        // A THROW is what a database fault actually does, and `{ ok: false }`
        // is what an unreadable address does; both are the same failure to
        // the person who asked to be left alone. (The same lesson
        // recordOptOut in calls.ts learned.) In a savepoint, so a fault here
        // takes the loud path below rather than aborting the reply.
        let added: Awaited<ReturnType<typeof addSuppression>>
        let why: string
        try {
          added = await tx.transaction((sp) =>
            addSuppression(sp as unknown as AgencyDb, {
              orgId: args.orgId,
              kind: suppressionKind,
              value: from,
              reason: `replied asking to stop, ${now.toISOString().slice(0, 10)}`,
              source: 'reply',
            }),
          )
          // `added.message` quotes the address back; the audit row and the log
          // carry a reason CLASS instead (§2.3).
          why = suppressionKind === 'phone' ? 'unparseable_number' : 'unparseable_address'
        } catch (err) {
          added = { ok: false, message: 'The suppression could not be written.' }
          why = err instanceof Error ? err.name : 'UnknownError'
        }
        suppressed = added.ok
        if (!added.ok) {
          // §2.1's Phase 4 obligation: a suppression insert that fails is an
          // opt-out that was never recorded — worse than any bug the constraint
          // replaced. The row still says `opted_out`, so the state is queryable;
          // the audit row is what the digest and the compliance page count; the
          // log line is what a person sees today. Never silently.
          optOutNotRecorded = true
          // And the pause says so, over the `replied …` just written (or any
          // earlier reason), as an unsubscribe's and an erasure's failure does.
          // Left as `replied …`, answering a later reply from /inbox resumed a
          // person whose opt-out was never recorded — and a fault that failed
          // the suppression can fail the audit row below too, leaving the inbox
          // nothing else to find. Found by review.
          //
          // Except when the reply came from somebody else (review round 7):
          // the opt-out is THEIRS, and the contact it is filed under never
          // asked to stop. They keep the reply's own pause, which a person
          // lifts — once the sender's address is on the suppression list, the
          // inbox's reading of this opted-out reply (its From matched by no
          // suppression row) lets them go too. The SENDER is held instead,
          // when they are a contact here (`holdTheSender`, below).
          if (fromIsContact !== false) {
            try {
              const overridden = await tx.transaction((sp) =>
                pauseContactOverriding(
                  sp as unknown as AgencyDb, args.orgId, args.contactId,
                  `opt-out not recorded: reply ${now.toISOString()} (${why})`, now,
                ),
              )
              paused = paused || overridden
            } catch (err) {
              said.push({
                message: 'an opt-out that was not recorded could not pause the contact',
                fields: {
                  touchId,
                  contactId: args.contactId,
                  orgId: args.orgId,
                  error: err instanceof Error ? err.name : 'UnknownError',
                },
              })
            }
          }
          // The row /compliance and the digest count. About the contact when
          // the reply was theirs — what keeps /inbox from drafting to them —
          // and otherwise about the reply itself, which holds the sender's
          // address, with the contact as `filedUnder`: never as a subject or a
          // `contactId`, the two things the inbox reads as THEIR opt-out.
          await tx
            .transaction((sp) =>
              appendAudit(
                sp as unknown as AgencyDb,
                fromIsContact === false
                  ? {
                      orgId: args.orgId,
                      actor: 'system',
                      action: 'contact.opt_out_not_recorded',
                      subjectType: 'touch',
                      subjectId: touchId,
                      detail: { touchId, channel: args.channel, why, fromIsContact: false, filedUnder: args.contactId },
                    }
                  : {
                      orgId: args.orgId,
                      actor: 'system',
                      action: 'contact.opt_out_not_recorded',
                      subjectType: 'contact',
                      subjectId: args.contactId,
                      detail: { touchId, channel: args.channel, why },
                    },
              ),
            )
            .catch(() => {})
          // And whoever IS the sender, when they are a contact here too
          // (review round 8, [2]): their opt-out is the one nobody recorded,
          // and the contact's reply pause above holds nobody but the contact.
          const sendersHeld =
            fromIsContact === false
              ? await holdTheSender(
                  tx,
                  { orgId: args.orgId, senders, channel: args.channel, touchId, why, now },
                  (message, fields) => said.push({ message, fields }),
                )
              : 0
          said.push({
            message: 'OPT-OUT NOT RECORDED — follow up by hand',
            fields: {
              touchId, contactId: args.contactId, orgId: args.orgId, why, fromIsContact,
              ...(fromIsContact === false ? { sendersHeld } : {}),
            },
          })
        }
      }

      let deal: string | null = null
      if (companyId && !automatic) {
        const moved = await tx
          .transaction((sp) =>
            advanceDeal(sp as unknown as AgencyDb, {
              orgId: args.orgId,
              companyId,
              to: 'replied',
              nextAction: 'Read the reply and answer it',
            }),
          )
          .catch(() => null)
        deal = moved ? `${moved.outcome}:${moved.deal.stage}` : null
      }

      await tx
        .transaction((sp) =>
          appendAudit(sp as unknown as AgencyDb, {
            orgId: args.orgId,
            actor: 'system',
            action: 'contact.replied',
            subjectType: 'contact',
            subjectId: args.contactId,
            // §2.3: the facts and the counts, never the reply's text.
            detail: { channel: args.channel, paused, cancelledQueued: cancelled.length, suppressed, deal, replyKind },
          }),
        )
        .catch(() => {})

      // Last, a read that FAILS if a swallowed failure above left the
      // transaction aborted after all, so the COMMIT that would quietly
      // discard the reply is never sent: the fault surfaces, the caller
      // answers 500, and the provider's retry records it.
      await tx.execute(sql`SELECT 1`)

      return {
        touchId, paused, cancelled: cancelled.length, suppressed, optOutNotRecorded, fromIsContact, deal, replyKind, companyId, companyDomain,
      }
    })
  } catch (err) {
    // Rolled back: nothing about this reply was stored. A webhook's provider
    // retries it; the worker's IMAP path leaves the message unseen and
    // retries it, a bounded number of times (`drainUnseen`). Until a retry
    // records it, a "stop" is §2.1's obligation unmet, so it is said out
    // loud — ids and a reason class, never the address or the words.
    //
    // Except a raced duplicate (review round 5). The one unique index the
    // inbound INSERT can meet is 0019's on an inbound SMS's message id: two
    // deliveries of one STOP both read "not seen", the winner recorded it
    // with its suppression, and this loser's INSERT was refused. Its caller
    // (`recordInboundSms`) answers it as the duplicate it is, so a line
    // telling a person to record by hand an opt-out that IS recorded would
    // be false — and a false alarm teaches people to skip the true one.
    const duplicate = providerId !== null && isUniqueViolation(err)
    if (optedOut && !duplicate) {
      log.error('OPT-OUT NOT RECORDED — the reply was rolled back; a provider retry records it, otherwise follow up by hand', {
        contactId: args.contactId,
        orgId: args.orgId,
        // The message it answered, when it was matched by one: an id a
        // caller can name in the alarm it raises (the email webhook does).
        inReplyTo: args.inReplyTo ?? null,
        // Whether the reply came from that contact (review round 7): false
        // is a colleague's stop filed under them, and the caller must not
        // hold THEM as an opt-out nobody recorded. Null: not known.
        fromIsContact,
        // And, for a colleague's stop, the contacts here who ARE the sender
        // (review round 8): the ones the caller holds as the opt-out nobody
        // recorded, by id. Ids only, never the address.
        ...(fromIsContact === false ? { senderContactIds: senders } : {}),
        why: err instanceof Error ? err.name : 'UnknownError',
      })
    }
    throw err
  }
  for (const line of said) log.error(line.message, line.fields)
  return recorded
}

export type InboundOutcome =
  | {
      readonly matched: 'message' | 'contact'
      readonly contactId: string
      readonly orgId: string
      readonly touchId: string
      readonly paused: boolean
      readonly suppressed: boolean
      readonly replyKind: ReplyKind
      /**
       * True when this Message-ID had already been recorded, so nothing was
       * written this time. A caller notifying somebody must not notify them
       * twice for one reply a provider retried.
       */
      readonly duplicate: boolean
      readonly companyId: string | null
      readonly companyDomain: string | null
      /**
       * The reply asked to be left alone and the suppression row could NOT
       * be written (`recordInboundReply`'s flag). Already audited and logged;
       * a caller with a way to reach a person — the web routes' Slack
       * notice — raises the alarm instead of announcing an ordinary reply,
       * because "asked to stop … paused" reads as handled, and it was not.
       * False on a duplicate: the first delivery raised it.
       */
      readonly optOutNotRecorded: boolean
      /**
       * `recordInboundReply`'s `fromIsContact`: false when the reply came
       * from somebody other than the contact (a colleague answering our
       * mail), so the alarm names the sender's message and never the
       * contact. Absent or null reads as the contact's own.
       */
      readonly fromIsContact?: boolean | null
    }
  | {
      readonly matched: 'none'
      readonly why: string
      /**
       * Present when the mail was a delivery report this system tied to a
       * message it SENT, and so acted on. A bounce is not a reply: to every
       * caller that handles replies — the Slack hook, the triage model, the
       * inbox — it is `none`, because nobody answered anything, and that is
       * why it lives on this branch rather than beside `message`/`contact`.
       * A caller that wants to say what happened reads it from here.
       */
      readonly bounce?: InboundBounce
    }

/** What a delivery report did, once it was tied to a message this system sent. */
export interface InboundBounce {
  readonly orgId: string
  readonly contactId: string
  /** The outbound message the report returned. */
  readonly touchId: string
  /** `5.x.x` (not `x.2.2`): the address is marked and its queue cancelled. Otherwise audit only. */
  readonly permanent: boolean
  /** The RFC 3463 status, as the report gave it. */
  readonly code: string
  /**
   * True when THIS report marked the contact. False for a transient one, and
   * for a permanent one that found the address already marked — a report an
   * IMAP reconnect presented twice changes nothing the second time.
   */
  readonly marked: boolean
}

/**
 * Record a permanent bounce: the mark, the cancelled queue, the audit row.
 *
 * A bounce is evidence about an ADDRESS, not a person asking to be left
 * alone — a typo is not an opt-out — so it is a column on the contact and a
 * refusal (`bounced`) in the send path, never a suppression row. The status
 * code is stored beside the time because it is the evidence (§2.2): a
 * person reading "bounced" can see `5.1.1` (no such mailbox) or `5.7.1`
 * (refused on policy) and fix the right thing.
 *
 * Only EMAIL touches are cancelled: the address that failed is the email
 * one, and the person may still be reachable on LinkedIn. `sending` rows
 * are left alone, as a reply leaves them — the worker owns those, and the
 * last look before the wire in `dispatchTouch` refuses them. A cancelled
 * ANSWER to their reply puts that reply's pause back, in this transaction
 * (`repauseForUnansweredReply`).
 *
 * `address`, when given, must still be the contact's email for the mark to
 * land: a report about the address somebody corrected an hour ago is about
 * an address this contact no longer has. Idempotent: an already-marked
 * contact keeps its FIRST mark and nothing is written or audited again.
 */
export async function outreachRecordBounce(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly code: string
    /** The folded address the report named; the mark lands only if it is still the contact's. */
    readonly address?: string | null
    /** The outbound message the report returned, for the audit row. */
    readonly touchId?: string | null
    readonly now?: Date
  },
): Promise<{ marked: boolean; cancelled: number }> {
  const code = args.code.trim()
  // The code is the evidence, so it must BE one: an RFC 3463 status, or
  // nothing is marked. `contacts_bounce_has_code` would take any string.
  if (!/^[45]\.\d{1,3}\.\d{1,3}$/.test(code)) return { marked: false, cancelled: 0 }
  const now = args.now ?? new Date()

  const result = await db.transaction(async (tx) => {
    const marked = await tx
      .update(schema.contacts)
      .set({ emailBouncedAt: now, emailBounceCode: code })
      .where(
        and(
          eq(schema.contacts.orgId, args.orgId),
          eq(schema.contacts.id, args.contactId),
          isNull(schema.contacts.emailBouncedAt),
          args.address
            ? sql`lower(${schema.contacts.email}) = ${args.address.toLowerCase()}`
            : isNotNull(schema.contacts.email),
        ),
      )
      .returning({ id: schema.contacts.id })
    if (marked.length === 0) return { marked: false, cancelled: 0 }

    // Marked refused rather than deleted, like a reply's cancel: the record
    // that a message was ABOUT to go, and why it did not, is the useful one.
    const cancelled = await tx
      .update(schema.touches)
      .set({ status: 'refused', refusalCode: 'bounced' })
      .where(
        and(
          eq(schema.touches.orgId, args.orgId),
          eq(schema.touches.contactId, args.contactId),
          eq(schema.touches.direction, 'out'),
          eq(schema.touches.channel, 'email'),
          inArray(schema.touches.status, ['queued', 'awaiting_approval', 'approved']),
        ),
      )
      .returning({ id: schema.touches.id, answersTouchId: schema.touches.answersTouchId })
    // An answer to their reply among them leaves that reply unanswered: its
    // pause goes back on, here, with the cancel (review round 4). A bounce
    // pauses nobody itself, so there is no stronger reason to keep.
    for (const answer of cancelled) {
      if (!answer.answersTouchId) continue
      await repauseForUnansweredReply(tx as unknown as AgencyDb, {
        orgId: args.orgId, answer, actor: 'system', because: 'bounced', now,
      })
    }
    return { marked: true, cancelled: cancelled.length }
  })

  if (result.marked) {
    await appendAudit(db, {
      orgId: args.orgId,
      actor: 'system',
      action: 'contact.bounced',
      subjectType: 'contact',
      subjectId: args.contactId,
      // §2.3: the code and the counts. Never the address.
      detail: { code, cancelledQueued: result.cancelled, ...(args.touchId ? { touchId: args.touchId } : {}) },
    }).catch(() => {})
  }
  return result
}

/**
 * A delivery report that named a failure. Acted on ONLY when it is tied to a
 * message this system sent — anyone can mail the inbox a well-formed DSN
 * naming any address, and a bounce read from the report alone would let a
 * stranger stop the agency writing to anyone they chose.
 *
 * The tie, in order of how directly it names the returned message: the
 * Message-ID of the copy the report carries (`originalMessageIds`, which the
 * IMAP parser reads from the message/rfc822 or text/rfc822-headers part),
 * the reporting MTA's `Original-Message-ID`, then the report's own
 * In-Reply-To/References (Gmail and Exchange set them). Then the address the
 * report names must be the address that message went to, and must still be
 * the contact's. Anything short of that changes no contact: it is audited as
 * `contact.bounce_unmatched` when the org is known, and otherwise answered
 * as `none` for the caller to log.
 */
async function handleBounce(
  db: AgencyDb,
  mail: {
    readonly references?: readonly string[]
    readonly originalMessageIds?: readonly string[]
    readonly now?: Date
  },
  signal: Extract<MailSignal, { kind: 'bounce' }>,
): Promise<InboundOutcome> {
  const ids = [
    ...new Set(
      [...(mail.originalMessageIds ?? []), signal.originalMessageId, ...(mail.references ?? [])]
        .map((id) => id?.trim() ?? '')
        .filter((id) => id.length > 0),
    ),
  ]
  const nothing = {
    matched: 'none',
    why: 'a delivery report that names no message this system sent; no contact was changed',
  } as const
  if (ids.length === 0) return nothing

  const hits = await db
    .select({
      id: schema.touches.id,
      orgId: schema.touches.orgId,
      contactId: schema.touches.contactId,
      recipient: schema.touches.recipient,
      providerId: schema.touches.providerId,
    })
    .from(schema.touches)
    .where(
      and(
        eq(schema.touches.direction, 'out'),
        eq(schema.touches.channel, 'email'),
        isNotNull(schema.touches.providerId),
        inArray(schema.touches.providerId, ids),
      ),
    )
    .limit(20)
  const people = new Set(hits.map((h) => `${h.orgId}/${h.contactId ?? ''}`))
  if (people.size > 1) {
    return { matched: 'none', why: 'a delivery report that names messages sent to more than one contact; no contact was changed' }
  }
  const hit = ids.map((id) => hits.find((h) => h.providerId === id)).find((h) => h !== undefined)
  if (!hit?.contactId) return nothing
  const contactId = hit.contactId

  const [contact] = await db
    .select({ email: schema.contacts.email })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, hit.orgId), eq(schema.contacts.id, contactId)))
    .limit(1)
  if (!contact) return nothing

  const sentTo = normaliseEmail(hit.recipient ?? '')
  const named = [signal.recipient, signal.originalRecipient]
    .map((a) => (a ? normaliseEmail(a) : null))
    .filter((a): a is string => a !== null)
  const why =
    sentTo === null
      ? 'no_recorded_recipient'
      : named.length === 0
        ? 'no_recipient'
        : !named.includes(sentTo)
          ? 'recipient_mismatch'
          : normaliseEmail(contact.email ?? '') !== sentTo
            ? 'address_changed'
            : null
  if (why !== null) {
    await appendAudit(db, {
      orgId: hit.orgId,
      actor: 'system',
      action: 'contact.bounce_unmatched',
      subjectType: 'contact',
      subjectId: contactId,
      // §2.3: why it was not acted on, and the report's code. No address.
      detail: { why, code: signal.status, permanent: signal.permanent, touchId: hit.id },
    }).catch(() => {})
    const words: Record<typeof why, string> = {
      no_recorded_recipient: 'the returned message has no recorded recipient',
      no_recipient: 'the report names no recipient',
      recipient_mismatch: 'the address it names is not the one that message went to',
      address_changed: 'the contact’s address has changed since that message went',
    }
    return { matched: 'none', why: `a delivery report that was not acted on — ${words[why]}; no contact was changed` }
  }

  if (!signal.permanent) {
    // A full mailbox, a greylisting server, a timeout: the address may well
    // work tomorrow, and marking it would stop a sequence for a person whose
    // inbox is merely busy. The row says it happened; nothing else changes.
    await appendAudit(db, {
      orgId: hit.orgId,
      actor: 'system',
      action: 'contact.bounce_transient',
      subjectType: 'contact',
      subjectId: contactId,
      detail: { code: signal.status, touchId: hit.id },
    }).catch(() => {})
    return {
      matched: 'none',
      why: `a temporary delivery failure (${signal.status}); recorded, and nothing was changed`,
      bounce: { orgId: hit.orgId, contactId, touchId: hit.id, permanent: false, code: signal.status, marked: false },
    }
  }

  const r = await outreachRecordBounce(db, {
    orgId: hit.orgId,
    contactId,
    code: signal.status,
    address: sentTo,
    touchId: hit.id,
    ...(mail.now ? { now: mail.now } : {}),
  })
  return {
    matched: 'none',
    why: r.marked
      ? `a permanent bounce (${signal.status}); the address is marked and ${r.cancelled} queued message(s) were cancelled`
      : `a permanent bounce (${signal.status}) for an address already marked; nothing changed`,
    bounce: { orgId: hit.orgId, contactId, touchId: hit.id, permanent: true, code: signal.status, marked: r.marked },
  }
}

/** The RFC 3464 actions, so a `why` never echoes an attacker's word back. */
const DSN_ACTIONS = new Set(['failed', 'delayed', 'delivered', 'relayed', 'expanded'])

/**
 * An inbound email, from IMAP or from a webhook — one function for both.
 *
 * First, what the mail says about ITSELF (`readMailSignals`, headers and the
 * delivery-status part only — never the body):
 *
 *  - A delivery report is never a reply. A failure is handled as a bounce
 *    (`handleBounce`: tied to a message this system sent, or it changes
 *    nothing); any other report — delayed, delivered — is answered `none`.
 *    Before this, a bounce from a server that sets References was filed as
 *    the contact REPLYING: paused, deal moved to `replied`.
 *  - An automatic answer (`Auto-Submitted`, `Precedence: bulk`, …) is still
 *    recorded as a reply, with `autoReply` set, so it is stored `auto_reply`
 *    and does not pause the contact, cancel their queue or move the deal —
 *    an out-of-office is not somebody answering. This is a behaviour change:
 *    before, every inbound paused. The opt-out reader still runs first
 *    inside `recordInboundReply`; an automatic mail that says "unsubscribe"
 *    is an opt-out and is suppressed, and one whose words mention removal
 *    or departure at all (`mentionsRemovalOrDeparture`) is handled as an
 *    ordinary reply and pauses.
 *
 * Without headers or a DSN nothing here changes, and the rest is as it was.
 *
 * Then matching a reply, in order of confidence:
 *
 *  1. `In-Reply-To` / `References` against the Message-ID a provider assigned
 *     to something this system sent. Unambiguous: it names the exact message,
 *     the contact, the campaign and the org.
 *  2. The From address against `contacts.email` — ONLY if it matches exactly
 *     one contact across every org. A mailbox that serves two orgs and gets a
 *     reply from an address both have on file cannot tell which conversation
 *     it belongs to, and guessing files somebody's reply under the wrong
 *     agency. It is logged and dropped instead.
 *
 * Returns what happened so the caller can log it. Never throws on a message
 * it cannot place: an IMAP listener that crashed on one odd email would stop
 * detecting every reply after it.
 */
export async function handleInboundEmail(
  db: AgencyDb,
  mail: {
    readonly from: string
    readonly subject: string | null
    readonly text: string | null
    readonly messageId?: string | null
    /** Every Message-ID in In-Reply-To and References, in that order. */
    readonly references?: readonly string[]
    /**
     * The mail's headers, when the caller has them — any case, any number;
     * `readMailSignals` reads the few it needs (see `MAIL_SIGNAL_HEADERS`).
     */
    readonly headers?: Readonly<Record<string, string>>
    /** The text of a `message/delivery-status` part, when the mail has one. */
    readonly dsn?: string | null
    /**
     * The Message-ID (then References) of the copy a delivery report
     * carries in its message/rfc822 or text/rfc822-headers part. Read only
     * for a bounce, to tie it to a message this system sent.
     */
    readonly originalMessageIds?: readonly string[]
    /** Forwarded to `recordInboundReply`; see `InboundLog`. */
    readonly log?: InboundLog
    readonly now?: Date
  },
): Promise<InboundOutcome> {
  // 0. What the mail says about itself, before anything is matched: a
  //    report's From is the reporting server, never the contact, so it must
  //    not reach the address rule below.
  const signal = readMailSignals({ headers: mail.headers ?? null, dsn: mail.dsn ?? null })
  if (signal?.kind === 'bounce') return handleBounce(db, mail, signal)
  const report = mail.dsn ? parseDsn(mail.dsn) : null
  if (report?.action) {
    const action = DSN_ACTIONS.has(report.action) ? report.action : 'unrecognised'
    return { matched: 'none', why: `a delivery report (${action}) is not a reply; nothing was recorded` }
  }
  const autoReply = signal?.kind === 'auto_reply'

  const from = normaliseEmail(mail.from)
  if (!from) return { matched: 'none', why: 'the From address could not be read' }

  // 1. Seen before. A webhook provider retries on any non-2xx and sometimes
  //    on a slow 2xx, and an IMAP reconnect can re-present a message; the
  //    Message-ID is the same each time, so the reply is recorded once.
  //    Answering `duplicate` and writing nothing is right only because
  //    `recordInboundReply` stores the reply and its consequences in one
  //    transaction: a stored row had its pause, cancel and opt-out stored
  //    with it, and a delivery that failed left no row, so its retry does
  //    not reach here. Re-applying them from the stored row instead was
  //    rejected: a NULL kind does not mark a half-recorded reply (every
  //    reply before 0017 has one), and re-pausing on a redelivery would
  //    undo a teammate's resume and cancel the answer they drafted since.
  if (mail.messageId) {
    const dup = await db
      .select({
        id: schema.touches.id,
        orgId: schema.touches.orgId,
        contactId: schema.touches.contactId,
        replyKind: schema.touches.replyKind,
        companyId: schema.touches.companyId,
        companyDomain: schema.companies.domain,
      })
      .from(schema.touches)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.touches.companyId))
      .where(and(eq(schema.touches.direction, 'in'), eq(schema.touches.providerId, mail.messageId)))
      .limit(1)
    if (dup[0]?.contactId) {
      // The kind comes off the stored row, not from re-reading the text: a
      // redelivery must answer exactly what the first delivery decided.
      return {
        matched: 'message',
        contactId: dup[0].contactId,
        orgId: dup[0].orgId,
        touchId: dup[0].id,
        paused: false,
        suppressed: false,
        replyKind: (dup[0].replyKind as ReplyKind | null) ?? 'other',
        duplicate: true,
        companyId: dup[0].companyId,
        companyDomain: dup[0].companyDomain,
        optOutNotRecorded: false,
      }
    }
  }

  // 2. By the message it answers.
  const refs = (mail.references ?? []).map((r) => r.trim()).filter(Boolean)
  if (refs.length > 0) {
    const hits = await db
      .select({ id: schema.touches.id, orgId: schema.touches.orgId, contactId: schema.touches.contactId })
      .from(schema.touches)
      .where(
        and(
          eq(schema.touches.direction, 'out'),
          isNotNull(schema.touches.providerId),
          inArray(schema.touches.providerId, refs),
        ),
      )
      .limit(1)
    const hit = hits[0]
    if (hit?.contactId) {
      const r = await recordInboundReply(db, {
        orgId: hit.orgId,
        contactId: hit.contactId,
        channel: 'email',
        from,
        subject: mail.subject,
        body: mail.text,
        providerId: mail.messageId ?? null,
        inReplyTo: hit.id,
        autoReply,
        ...(mail.now ? { now: mail.now } : {}),
        ...(mail.log ? { log: mail.log } : {}),
      })
      return {
        matched: 'message',
        replyKind: r.replyKind,
        contactId: hit.contactId,
        orgId: hit.orgId,
        touchId: r.touchId,
        paused: r.paused,
        suppressed: r.suppressed,
        duplicate: false,
        companyId: r.companyId,
        companyDomain: r.companyDomain,
        optOutNotRecorded: r.optOutNotRecorded,
        fromIsContact: r.fromIsContact,
      }
    }
  }

  // 3. By the address, only when it is unambiguous.
  const contacts = await db
    .select({ id: schema.contacts.id, orgId: schema.contacts.orgId })
    .from(schema.contacts)
    .where(sql`lower(${schema.contacts.email}) = ${from}`)
    .limit(2)
  if (contacts.length === 0) return { matched: 'none', why: 'no contact has this address' }
  if (contacts.length > 1) {
    return { matched: 'none', why: 'this address belongs to contacts in more than one org, and nothing says which' }
  }
  const only = contacts[0]!
  const r = await recordInboundReply(db, {
    orgId: only.orgId,
    contactId: only.id,
    channel: 'email',
    from,
    subject: mail.subject,
    body: mail.text,
    providerId: mail.messageId ?? null,
    autoReply,
    ...(mail.now ? { now: mail.now } : {}),
    ...(mail.log ? { log: mail.log } : {}),
  })
  return {
    matched: 'contact', contactId: only.id, orgId: only.orgId,
    touchId: r.touchId, paused: r.paused, suppressed: r.suppressed, replyKind: r.replyKind,
    duplicate: false, companyId: r.companyId, companyDomain: r.companyDomain,
    optOutNotRecorded: r.optOutNotRecorded, fromIsContact: r.fromIsContact,
  }
}

/** The most recent outbound and inbound touches for a company — the thread. */
export async function companyThread(
  db: AgencyDb,
  orgId: string,
  companyId: string,
  limit = 50,
): Promise<TouchRow[]> {
  return db
    .select()
    .from(schema.touches)
    .where(and(eq(schema.touches.orgId, orgId), eq(schema.touches.companyId, companyId)))
    .orderBy(desc(schema.touches.createdAt))
    .limit(limit)
}
