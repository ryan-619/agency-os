import { z } from 'zod'
import type { SendDecision } from '@agency/core'
import { smsDraft, type AgencyDb, type SmsDraftCheck, type SmsDraftOutcome, type SmsDraftRefusal } from '@agency/db/queries'

/**
 * `POST /api/contacts/[id]/sms`, everything but the session (0019): what a
 * request may carry, the one call it makes (`smsComposerAnswer`), and what
 * each of `smsDraft`'s answers becomes on the wire.
 *
 * Kept beside the route, with no `server-only` and no `@/` import, so
 * `apps/web/test/sms-composer.test.ts` runs the route's own mapping and
 * `apps/web/test/sms-route.test.ts` the route's own call, against a real
 * database. The route reads the session and the body, and hands the rest
 * here.
 */

/** A body is three ids and the values: a few kilobytes at most. */
export const SMS_MAX_REQUEST_BYTES = 16_384

/**
 * One draft, or — with `dryRun` — the question before it: what would the
 * send path say about THESE words to this person under this campaign? The
 * values are bounded generously; the 30-character rule is the renderer's,
 * which answers it with a sentence naming the slot.
 */
export const smsDraftSchema = z.object({
  campaignId: z.uuid('Choose an SMS campaign — its cap and quiet hours are part of the answer.'),
  templateId: z.uuid('Choose a registered template.'),
  vars: z.array(z.string().max(500, 'A value is far longer than a DLT variable holds.')).max(50, 'Too many values.'),
  dryRun: z.boolean().optional(),
})
export type SmsDraftInput = z.infer<typeof smsDraftSchema>

/**
 * The status each refusal is answered with. 404 for what is not in this org,
 * 400 for a choice that cannot be right (an email campaign, a WhatsApp
 * template), 422 for values that do not render, and 409 for everything that
 * is a fact about the world right now — no number, a template switched off,
 * a draft already waiting, and the send path's own refusal.
 */
export const SMS_DRAFT_STATUS: Readonly<Record<SmsDraftRefusal, number>> = {
  no_such_contact: 404,
  no_phone: 409,
  no_such_campaign: 404,
  not_an_sms_campaign: 400,
  campaign_not_active: 409,
  no_such_template: 404,
  not_an_sms_template: 400,
  template_inactive: 409,
  render_failed: 422,
  already_queued: 409,
  refused: 409,
}

/** Said beside every draft, because "drafted" must never read as "sent". */
export const SMS_DRAFTED_NOTE =
  'Drafted, and nothing was sent. It waits on /approvals for a person; the worker sends it only after every rule — ' +
  'the template, the opt-in, the suppression list, the quiet hours — passes again at that moment.'

export interface WireAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** `smsDraft`'s outcome as a response. The sentence is the query's own; the words are returned only to the drafter. */
export function smsDraftAnswer(outcome: SmsDraftOutcome, nothingWillSend: string | null): WireAnswer {
  if (!outcome.ok) {
    return {
      status: SMS_DRAFT_STATUS[outcome.reason],
      body: {
        error: outcome.message,
        reason: outcome.reason,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.slot !== undefined ? { slot: outcome.slot } : {}),
      },
    }
  }
  return {
    status: 201,
    body: {
      touchId: outcome.touchId,
      body: outcome.body,
      wouldHold: outcome.wouldHold,
      note: SMS_DRAFTED_NOTE,
      deployment: nothingWillSend,
    },
  }
}

/**
 * The dry run's answer: the decision the send path would make about these
 * words, and whether it blocks the draft. `blocked` is a refusal nobody may
 * approve past (`humanCanResolve: false`) — `smsDraft` would refuse it too,
 * so the composer says so before anybody asks. A refusal a person can
 * resolve does not block: the draft is written, and at sending the worker
 * HOLDS the clock's refusals (quiet hours, TRAI's band, the cap) and refuses
 * the rest (a missing timezone, say) — the composer says which.
 */
export function smsCheckAnswer(input: {
  readonly decision: SendDecision
  readonly wouldNeedApproval: boolean
  readonly body: string
}): WireAnswer {
  const { decision } = input
  const blocked = !decision.allowed && !decision.humanCanResolve
  return {
    status: 200,
    body: {
      rendered: true,
      body: input.body,
      decision: decision.allowed
        ? { allowed: true, code: decision.code }
        : { allowed: false, code: decision.code, reason: decision.reason, humanCanResolve: decision.humanCanResolve },
      wouldNeedApproval: input.wouldNeedApproval,
      blocked,
    },
  }
}

/**
 * The dry run when the values do not render: not an error — the answer to
 * the question, with the slot. Says once that nothing was drafted, whether
 * the sentence is the renderer's own or `smsDraft`'s, which already says so.
 */
export function smsRenderAnswer(render: { readonly message: string; readonly slot?: number }): WireAnswer {
  const said = / Nothing was drafted\.$/.test(render.message) ? render.message : `${render.message} Nothing was drafted.`
  return {
    status: 200,
    body: { rendered: false, error: said, ...(render.slot !== undefined ? { slot: render.slot } : {}) },
  }
}

/**
 * `smsDraft`'s dry run on the wire. Every refusal `smsDraft` answers is
 * answered exactly as a draft's would be — a paused campaign, an SMS already
 * waiting, another org's template — so Check never offers a Draft that then
 * answers 409; values that do not render are the answer to the question
 * (`smsRenderAnswer`); past those, the send path's decision (`smsCheckAnswer`).
 */
export function smsDryRunAnswer(check: SmsDraftCheck): WireAnswer {
  if (check.ok) return smsCheckAnswer(check)
  if (check.reason === 'render_failed') return smsRenderAnswer(check)
  return smsDraftAnswer(check, null)
}

export interface ComposerLog {
  error(message: string, fields?: Record<string, unknown>): void
}

/** Said when the database failed under a draft or a check. Nothing was written: `smsDraft` inserts in one transaction. */
export const SMS_FAULT =
  'That could not be completed because the database did not answer. Nothing was drafted and nothing was sent — try again.'

/**
 * The route's one call: `smsDraft` — with `dryRun: true` for Check, so the
 * two run the same checks in the same order and cannot disagree — mapped to
 * the wire.
 *
 * A fault is caught HERE and answered 500 with a sentence, with one log
 * line naming the fault's CLASS: drizzle's error message lists every bound
 * parameter — the contact's number and the words typed into the template —
 * and Next `console.error`s an escaping error whole, past `redact()`.
 */
export async function smsComposerAnswer(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly contactId: string
    readonly createdBy: string
    readonly input: SmsDraftInput
    readonly now: Date
    /** `nothingWillSendNote(deployment())`, said beside a draft. */
    readonly nothingWillSend: string | null
  },
  log: ComposerLog,
): Promise<WireAnswer> {
  const draft = {
    orgId: args.orgId,
    contactId: args.contactId,
    campaignId: args.input.campaignId,
    templateId: args.input.templateId,
    vars: args.input.vars,
    createdBy: args.createdBy,
    now: args.now,
  }
  try {
    if (args.input.dryRun) return smsDryRunAnswer(await smsDraft(db, { ...draft, dryRun: true }))
    return smsDraftAnswer(await smsDraft(db, draft), args.nothingWillSend)
  } catch (err) {
    log.error(args.input.dryRun ? 'SMS check could not be run' : 'SMS draft could not be written', {
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    return { status: 500, body: { error: SMS_FAULT } }
  }
}
