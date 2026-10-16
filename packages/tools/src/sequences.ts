/**
 * A campaign's follow-up steps, from chat (0024): set them, or remove them.
 *
 * Carded: a step is words that will reach a person — drafted for /approvals
 * on its day, or sent unread where the campaign auto-sends — so a person
 * approves the call before the steps exist, as for `enrol_contacts`. The
 * steps themselves send nothing now; every message they draft goes through
 * the one send path, and a reply stops a person's sequence for good.
 */
import { z } from 'zod'
import { can } from '@agency/core'
import { campaignStepsSave } from '@agency/db'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const stepShape = z.object({
  kind: z.enum(['message', 'call', 'visit']),
  afterDays: z.number().int().min(1).max(90).describe('Days after the step before: after its message was sent, or its task made.'),
  subject: z.string().max(200).optional().describe('An email step’s subject; leave it out to reply on the opener’s subject.'),
  body: z.string().max(4000).optional().describe('A message step’s words; {first_name}, {company} and {agency} are filled in.'),
})

const shape = {
  campaignId: z.string().uuid().describe('The campaign, by the id list_campaigns prints.'),
  steps: z.array(stepShape).max(9).describe('Every step after the opener, in order; an empty list removes them.'),
}

export const setCampaignSteps: AgencyToolSpec<typeof shape> = {
  name: 'set_campaign_steps',
  description:
    'Set a campaign’s follow-up steps after its opener — another message on its channel, a call task or a visit task, ' +
    'each some days after the step before — replacing whatever it had (an empty list removes them). For each person the ' +
    'campaign wrote to in the last 30 days who has not replied, the next step comes on its day: a message is drafted for ' +
    '/approvals, or goes unread where the campaign auto-sends; a call or a visit is a task. A reply, a pause, a closed deal ' +
    'or a message that did not go stops them for good. Nothing is sent now. An SMS campaign takes calls and visits only.',
  shape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'campaigns:write')) return fail('not_permitted', 'The person you are helping cannot change campaigns.')
    const r = await campaignStepsSave(ctx.db, {
      orgId: ctx.orgId,
      campaignId: input.campaignId,
      actor: 'agent',
      steps: input.steps.map((s, i) => ({
        position: i + 2,
        kind: s.kind,
        afterDays: s.afterDays,
        subject: s.kind === 'message' ? s.subject ?? null : null,
        body: s.kind === 'message' ? s.body ?? null : null,
      })),
    })
    if (!r.ok) return fail(r.reason === 'not_found' ? 'not_found' : 'invalid_state', `${r.message} Nothing was changed.`)
    await ctx.audit('agent.set_campaign_steps', { campaignId: input.campaignId, steps: r.steps.length })
    if (r.steps.length === 0) {
      return ok({ steps: 0 }, 'Removed the campaign’s follow-up steps: nobody it writes to is followed up after the opener. Nothing was sent.')
    }
    return ok(
      { steps: r.steps.length },
      bounded([
        `Set ${r.steps.length} follow-up ${r.steps.length === 1 ? 'step' : 'steps'}:`,
        ...r.steps.map((s) => `  step ${s.position}: ${s.kind === 'message' ? 'a message' : `a ${s.kind} task`} ${s.afterDays} ${s.afterDays === 1 ? 'day' : 'days'} after the step before`),
        'Nothing was sent now. Each person the campaign wrote to who has not replied gets the next step on its day — a ' +
          'message as a draft on /approvals (or sent unread if the campaign auto-sends), a call or visit as a task — and a ' +
          'reply stops them for good.',
      ]),
    )
  },
}
