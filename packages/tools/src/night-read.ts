/**
 * What the night shift found (0025), from chat and the morning brief: the
 * last night's report and its morning list, best first. A read — the night
 * shift's settings and searches are an owner's, on Settings → Night shift.
 */
import { NEEDS, can } from '@agency/core'
import { nightReportLatest, nightSearchesList, nightShiftRead } from '@agency/db'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const shape = {}

export const getNightFinds: AgencyToolSpec<typeof shape> = {
  name: 'get_night_finds',
  description:
    'Read what the night shift found: its last run — the saved Google Maps searches it ran, the new businesses it filed, ' +
    'scanned and measured — and the morning list of the best new finds, best first, each with what it needs, its rating, ' +
    'whether a phone is on file and its domain (for get_opportunities, create_quote or create_share_link). A read.',
  shape,
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:read')) return fail('not_permitted', 'The person you are helping cannot read companies.')
    const [night, searches, report] = await Promise.all([
      nightShiftRead(ctx.db, ctx.orgId),
      nightSearchesList(ctx.db, ctx.orgId),
      nightReportLatest(ctx.db, ctx.orgId),
    ])
    await ctx.audit('agent.get_night_finds', { found: report?.top.length ?? 0 })
    const setup = night.enabled
      ? `The night shift is on, at ${night.runAt} ${night.timeZone}, with ${searches.filter((s) => s.active).length} active saved ${searches.length === 1 ? 'search' : 'searches'}.`
      : 'The night shift is off: an owner switches it on in Settings → Night shift, with saved Google Maps searches. It needs the worker to hold the Google key.'
    if (!report) return ok({ ran: false }, `${setup} It has not run yet. A read; nothing was changed.`)
    return ok(
      { ran: true, date: report.date, top: report.top.map((c) => c.domain) },
      bounded([
        setup,
        `Last run ${report.date ?? report.at.toISOString().slice(0, 10)}: ${report.searches} ${report.searches === 1 ? 'search' : 'searches'}, ` +
          `${report.added} new ${report.added === 1 ? 'business' : 'businesses'}, ${report.scanned} scanned, ${report.audited} measured on a phone.`,
        ...(report.top.length === 0
          ? ['None of the new finds needed anything we could see yet.']
          : [
              'The morning list, best first:',
              ...report.top.map((c, i) => {
                const needs = (report.needs.get(c.id) ?? []).map((k) => NEEDS[k].label)
                const facts = [
                  c.googleCategory?.replace(/_/g, ' '),
                  c.city,
                  c.googleRating !== null ? `★${Number(c.googleRating).toFixed(1)}${c.googleReviewCount ? ` from ${c.googleReviewCount}` : ''}` : null,
                  c.phone ? 'phone on file' : 'no phone on file',
                ].filter(Boolean)
                return `  ${i + 1}. ${c.name || c.domain} · ${c.domain} · ${facts.join(' · ')}${needs.length ? ` — needs: ${needs.join('; ')}` : ''}`
              }),
            ]),
        'A read; nothing was changed.',
      ]),
    )
  },
}
