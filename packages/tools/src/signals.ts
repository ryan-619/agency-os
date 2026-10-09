/**
 * What changed (2026-10-09), from chat and the morning brief: the companies
 * whose latest scan differs from the one before — a gap closed (they are
 * investing) or a gap opened (a problem they can see) — newest first, with
 * whether a deal is open and a task was made. A read; `recordScan` wrote
 * the rows, and only what the scanner observed is in them.
 */
import { z } from 'zod'
import { can, parseIcpDefinition } from '@agency/core'
import { activeIcpProfile, whatChanged, EVIDENCE_SIGNALS_DAYS, EVIDENCE_SIGNALS_MAX } from '@agency/db'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const shape = {
  sinceDays: z.number().int().min(1).max(90).optional().describe(`How far back to look. Default ${EVIDENCE_SIGNALS_DAYS}.`),
  limit: z.number().int().min(1).max(50).optional().describe(`At most this many companies. Default ${EVIDENCE_SIGNALS_MAX}.`),
}

export const getEvidenceSignals: AgencyToolSpec<typeof shape> = {
  name: 'get_evidence_signals',
  description:
    'Read what changed on companies’ sites since our previous scan of each — a gap fixed (they are investing in their ' +
    'site) or a gap opened (a problem they can see for themselves) — newest first, with the signals by name, whether a ' +
    'deal is open and whether a task was made. Dated reasons to reach out, from our own scans only. A read.',
  shape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:read')) return fail('not_permitted', 'The person you are helping cannot read companies.')
    const sinceDays = input.sinceDays ?? EVIDENCE_SIGNALS_DAYS
    const [signals, icp] = await Promise.all([
      whatChanged(ctx.db, { orgId: ctx.orgId, now: ctx.now(), sinceDays, ...(input.limit ? { limit: input.limit } : {}) }),
      activeIcpProfile(ctx.db, ctx.orgId),
    ])
    let why: Readonly<Record<string, { readonly why: string }>> = {}
    try {
      why = parseIcpDefinition(icp?.definition).signals
    } catch {
      // Keys read as themselves.
    }
    await ctx.audit('agent.get_evidence_signals', { sinceDays, returned: signals.length })
    if (signals.length === 0) {
      return ok(
        { signals: [] },
        `No company's latest scan differs from the one before it in the last ${sinceDays} days — or none has two scans ` +
          'that reached the site, which is not the same thing. A read; nothing was changed.',
      )
    }
    const name = (k: string) => why[k]?.why ?? k
    return ok(
      { signals: signals.map((s) => ({ domain: s.company.domain, at: s.at.toISOString(), fixed: s.fixed, regressed: s.regressed, openDeal: s.openDeal, taskId: s.taskId })) },
      bounded([
        `${signals.length} compan${signals.length === 1 ? 'y' : 'ies'} whose latest scan differs from the one before, newest first:`,
        ...signals.map((s) => {
          const parts = [
            s.regressed.length ? `new gaps: ${s.regressed.map(name).join('; ')}` : null,
            s.fixed.length ? `fixed: ${s.fixed.map(name).join('; ')}` : null,
            s.openDeal ? 'open deal' : 'no open deal',
            s.taskId ? 'a task was made' : null,
          ].filter(Boolean)
          return `  ${s.at.toISOString().slice(0, 10)}  ${s.company.name || s.company.domain} · ${s.company.domain} — ${parts.join(' · ')}`
        }),
        'Only what the latest scan observed may be quoted: read get_company before writing to anyone. A read; nothing was changed.',
      ]),
    )
  },
}
