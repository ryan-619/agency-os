import { z } from 'zod'
import type { SendDecision } from '@agency/core'
import type { SmsDraftOutcome, SmsDraftRefusal } from '@agency/db/queries'

/**
 * `POST /api/contacts/[id]/sms`, the pure half (0019): what a request may
 * carry, and what each of `smsDraft`'s answers becomes on the wire.
 *
 * Kept beside the route, importing types and zod only, so
 * `apps/web/test/sms-composer.test.ts` runs the route's own mapping.
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

/** `smsDraft`'s own `no_phone` sentence, for the dry run that asks first. */
export const NO_PHONE =
  'This contact has no phone number in international form (+91 98765 43210), so there is nobody to text and the ' +
  'suppression list cannot be checked. Fix the contact first.'

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
 * resolve (quiet hours, TRAI's band, the cap) does not block: the draft is
 * written and held at sending.
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

/** The dry run when the values do not render: not an error — the answer to the question, with the slot. */
export function smsRenderAnswer(render: { readonly message: string; readonly slot?: number }): WireAnswer {
  return {
    status: 200,
    body: { rendered: false, error: `${render.message} Nothing was drafted.`, ...(render.slot !== undefined ? { slot: render.slot } : {}) },
  }
}
