/**
 * What's working, from chat (2026-10-08): who replied, by kind of business
 * and by campaign — and after which message — what links and quotes became,
 * and searches for more businesses like the ones won. A read; the same
 * numbers as /insights.
 */
import { can, formatMoney } from '@agency/core'
import { INSIGHTS_WINDOW_DAYS, lookalikeSearches, rateWords, whatsWorking } from '@agency/db'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const shape = {}

export const getWhatsWorking: AgencyToolSpec<typeof shape> = {
  name: 'get_whats_working',
  description:
    'Read what is working, over the last 90 days: of the people written to, who replied, was interested, asked to stop ' +
    'or became a won deal — by kind of business, by city and by campaign, with which message in a campaign drew the reply — ' +
    'how the links businesses were sent got opened, what quotes became, and Google Maps searches for more businesses ' +
    'like the ones won (for find_businesses). Under five people a rate is too few to tell. A read.',
  shape,
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'deals:read')) return fail('not_permitted', 'The person you are helping cannot read the pipeline.')
    const [w, lookalikes] = await Promise.all([whatsWorking(ctx.db, { orgId: ctx.orgId, now: ctx.now() }), lookalikeSearches(ctx.db, ctx.orgId)])
    await ctx.audit('agent.get_whats_working', { kinds: w.byKind.length, campaigns: w.byCampaign.length })
    const line = (label: string, r: { written: number; replied: number; interested: number; optedOut: number; won: number }) =>
      `  ${label}: written to ${r.written} · replied ${rateWords(r.replied, r.written)} · interested ${rateWords(r.interested, r.written)}` +
      ` · asked to stop ${rateWords(r.optedOut, r.written)} · won ${r.won}`
    return ok(
      { kinds: w.byKind.length, campaigns: w.byCampaign.length, lookalikes: lookalikes.map((l) => l.query) },
      bounded([
        `Over the last ${INSIGHTS_WINDOW_DAYS} days (each person once, from their first message; an auto-reply is not a reply):`,
        ...(w.byKind.length === 0 ? ['  Nobody was written to in this window.'] : ['By kind of business:', ...w.byKind.slice(0, 8).map((r) => line(r.key ? r.key.replace(/_/g, ' ') : 'not found on the map', r))]),
        ...(w.byCampaign.length === 0
          ? []
          : [
              'By campaign:',
              ...w.byCampaign.map(
                (c) =>
                  `${line(`“${c.name}”`, c)}${c.afterMessage.length ? ` · replies came after message ${c.afterMessage.map((a) => `${a.n} (${a.replied})`).join(', ')}` : ''}`,
              ),
            ]),
        ...(w.pages.length ? [`Links: ${w.pages.map((p) => `${p.kind} ${p.opened} of ${p.made} opened`).join('; ')}.`] : []),
        `Quotes sent: ${w.quotes.sent}; accepted ${rateWords(w.quotes.accepted, w.quotes.sent)}; declined ${w.quotes.declined}` +
          `${w.quotes.acceptedValue > 0 ? `; ${formatMoney(w.quotes.acceptedValue, 'INR')} accepted` : ''}.`,
        ...(lookalikes.length
          ? [`More like what was won — searches for find_businesses: ${lookalikes.map((l) => `"${l.query}" (${l.won} won)`).join('; ')}.`]
          : []),
        'A read; nothing was changed.',
      ]),
    )
  },
}
