/**
 * The ideal-customer profiles, from chat (0021): list them, derive a new one
 * for a market or a size band, and switch the active one.
 *
 * A profile is never edited in place — every score names the profile it was
 * computed under — so "target small and mid-size companies in India" is a NEW
 * profile derived from the active one (`create_icp`, stored inactive), and
 * making it the one scans are judged by is a separate act (`activate_icp`),
 * which raises a card: it changes how every later scan is scored, and each
 * company is re-scanned before its next proposal (`rescore`). Both writes are
 * an owner's (`agents:write`, as the Assistant page and the subagents are):
 * the profile is the agent's scoring brief.
 *
 * Scoring is the scanner's signals, the same in every market; a profile's
 * markets and headcount band are WHO the agency targets. They count in a
 * score only through the profile's firmographic disqualifiers — a recorded
 * headcount over its maximum (`enterprise_scale`), and, where the profile asks
 * for them, under its minimum (`too_small`) or a recorded country outside its
 * markets (`outside_geos`). Unknown is never a mismatch.
 */
import { z } from 'zod'
import {
  COMPANY_STAGES, can, countryName, icpTargeting, parseIcpDefinition, type IcpChanges, type IcpDefinition,
  type IcpTargeting,
} from '@agency/core'
import { activateIcpProfile, createIcpProfile, icpProfilesList } from '@agency/db'
import { bounded, fail, ok, type AgencyToolSpec, type ToolOutcome } from './spec.js'

const NOTHING_SENT = 'Nothing was sent.'

/** "India, United States" — or "every market". */
function marketsWords(t: IcpTargeting): string {
  return t.geos.length === 0 ? 'every market' : t.geos.map(countryName).join(', ')
}

/** "15–400 staff", "up to 500 staff", "any size". */
function sizeWords(t: IcpTargeting): string {
  const n = (v: number) => v.toLocaleString('en')
  if (t.headcountMin !== null && t.headcountMax !== null) return `${n(t.headcountMin)}–${n(t.headcountMax)} staff`
  if (t.headcountMax !== null) return `up to ${n(t.headcountMax)} staff`
  if (t.headcountMin !== null) return `${n(t.headcountMin)}+ staff`
  return 'any size'
}

/** The firmographic disqualifiers this profile applies, in words. */
function enforcedWords(d: IcpDefinition, t: IcpTargeting): string {
  const on: string[] = []
  if (d.disqualifiers.enterprise_scale && t.headcountMax !== null) on.push(`over ${t.headcountMax.toLocaleString('en')} staff`)
  if (d.disqualifiers.too_small && t.headcountMin !== null) on.push(`under ${t.headcountMin.toLocaleString('en')} staff`)
  if (d.disqualifiers.outside_geos && t.geos.length > 0) on.push('outside its markets')
  return on.length === 0
    ? 'no company is disqualified for its size or market'
    : `a company recorded as ${on.join(' or ')} is disqualified at its next scan`
}

function profileLine(name: string, active: boolean, d: IcpDefinition | null, scores: number): string {
  if (!d) return `${active ? '● ACTIVE ' : '         '} ${name} — its definition does not parse`
  const t = icpTargeting(d)
  return (
    `${active ? '● ACTIVE ' : '         '} ${name} — markets: ${marketsWords(t)}; ${sizeWords(t)}; ` +
    `qualifies at ${d.scoring.qualify_at}; ${Object.keys(d.signals).length} signals; ` +
    `${scores.toLocaleString('en')} score${scores === 1 ? '' : 's'} computed under it`
  )
}

// ---------------------------------------------------------------------------
// list_icps
// ---------------------------------------------------------------------------

export const listIcps: AgencyToolSpec<Record<string, never>> = {
  name: 'list_icps',
  description:
    'List every ideal-customer profile the agency has: which one is active (every scan is scored under it), ' +
    'the markets and headcount band each targets, its qualifying score, and how many scores were computed ' +
    'under it. Read this before sourcing companies for a market or a size band, to see whether a profile ' +
    'already targets it.',
  shape: {},
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    const rows = await icpProfilesList(ctx.db, ctx.orgId)
    await ctx.audit('agent.list_icps', { profiles: rows.length })
    if (rows.length === 0) {
      return fail('not_found', 'There is no ICP profile at all. Run the seed, or ask an owner to set one up.')
    }
    const parsed = rows.map((r) => {
      let d: IcpDefinition | null = null
      try {
        d = parseIcpDefinition(r.definition)
      } catch {
        d = null
      }
      return { r, d }
    })
    return ok(
      {
        profiles: parsed.map(({ r, d }) => ({
          id: r.id,
          name: r.name,
          active: r.active,
          scores: r.scores,
          targeting: d ? icpTargeting(d) : null,
          qualifyAt: d?.scoring.qualify_at ?? null,
        })),
      },
      bounded([
        `${rows.length} profile${rows.length === 1 ? '' : 's'}. Scans are scored under the ACTIVE one; scoring reads ` +
          'the same public signals in every market, and a profile’s markets and size band are who it targets.',
        ...parsed.map(({ r, d }) => profileLine(r.name, r.active, d, r.scores)),
        ...parsed.flatMap(({ r, d }) =>
          r.active && d ? [`The active profile: ${enforcedWords(d, icpTargeting(d))}.`] : [],
        ),
        'create_icp derives a new profile for another market or size band (an owner’s act); activate_icp switches ' +
          'the active one, with a person’s approval. A read: nothing was changed.',
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// create_icp
// ---------------------------------------------------------------------------

const createIcpShape = {
  label: z
    .string()
    .min(3)
    .max(80)
    .describe('The new profile’s name, which says who it targets, e.g. "Security-gap SaaS (India, 10–500 staff)".'),
  basedOn: z
    .string()
    .max(80)
    .optional()
    .describe('The profile to start from, by name (list_icps). Default: the active one. Its signals and weights carry over.'),
  geos: z
    .array(z.string().max(60))
    .max(60)
    .optional()
    .describe('Its markets, as country names or two-letter codes, e.g. ["India"] or ["IN", "AE"]. Replaces the base’s list.'),
  headcountMin: z.number().int().min(1).max(10_000_000).nullable().optional().describe('The smallest company it targets, in staff. null: no minimum.'),
  headcountMax: z.number().int().min(1).max(10_000_000).nullable().optional().describe('The largest company it targets, in staff. null: no maximum.'),
  stages: z.array(z.enum(COMPANY_STAGES)).max(COMPANY_STAGES.length).optional().describe('The funding stages it targets.'),
  mustHave: z.array(z.string().max(160)).max(10).optional().describe('What a target must have, in a line each.'),
  positioning: z.string().max(1000).optional().describe('Who it is for and the wedge, in a paragraph.'),
  weights: z
    .record(z.string().max(60), z.number().int().min(1).max(50))
    .optional()
    .describe('New weights for signals the base already scores, e.g. {"compliance_claim": 15}. Never a new signal.'),
  disqualifyOutsideGeos: z.boolean().optional().describe('Disqualify a company whose recorded country is outside its markets.'),
  disqualifyTooSmall: z.boolean().optional().describe('Disqualify a company whose recorded headcount is under the minimum.'),
}

export const createIcp: AgencyToolSpec<typeof createIcpShape> = {
  name: 'create_icp',
  description:
    'Create a new ideal-customer profile for a market or a size band — e.g. small and mid-size SaaS companies ' +
    'in India — derived from the active profile (or another, by name), keeping its signals and weights unless ' +
    'told otherwise. It is stored INACTIVE: nothing is scored under it until activate_icp makes it the active ' +
    'one. A profile is never edited in place; a change is a new profile. An owner’s act. Nothing is sent.',
  shape: createIcpShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'agents:write')) {
      return fail('not_permitted', `Only an owner can create a profile — it is the agent’s scoring brief. ${NOTHING_SENT}`)
    }
    const headcount =
      input.headcountMin !== undefined || input.headcountMax !== undefined
        ? {
            ...(input.headcountMin !== undefined ? { min: input.headcountMin } : {}),
            ...(input.headcountMax !== undefined ? { max: input.headcountMax } : {}),
          }
        : undefined
    const changes: IcpChanges = {
      label: input.label,
      ...(input.positioning !== undefined ? { positioning: input.positioning } : {}),
      ...(input.geos !== undefined ? { geos: input.geos } : {}),
      ...(headcount ? { headcount } : {}),
      ...(input.stages !== undefined ? { stages: input.stages } : {}),
      ...(input.mustHave !== undefined ? { mustHave: input.mustHave } : {}),
      ...(input.weights !== undefined ? { weights: input.weights } : {}),
      ...(input.disqualifyOutsideGeos !== undefined ? { disqualifyOutsideGeos: input.disqualifyOutsideGeos } : {}),
      ...(input.disqualifyTooSmall !== undefined ? { disqualifyTooSmall: input.disqualifyTooSmall } : {}),
    }
    const r = await createIcpProfile(ctx.db, {
      orgId: ctx.orgId,
      actor: 'agent',
      ...(input.basedOn !== undefined ? { basedOn: input.basedOn } : {}),
      changes,
    })
    if (!r.ok) {
      await ctx.audit('agent.create_icp', { created: false, reason: r.reason })
      return fail(r.reason === 'no_base' ? 'not_found' : 'invalid_state', `${r.message} Nothing was created.`)
    }
    await ctx.audit('agent.create_icp', { created: true, profileId: r.id })
    const t = icpTargeting(r.definition)
    return ok(
      { profileId: r.id, name: r.name, basedOn: r.basedOn, active: false, targeting: t },
      [
        `Created the profile "${r.name}" from "${r.basedOn}": markets ${marketsWords(t)}; ${sizeWords(t)}; ` +
          `qualifies at ${r.definition.scoring.qualify_at}; ${enforcedWords(r.definition, t)}.`,
        `It is NOT active: scans are still scored under the active profile. activate_icp makes "${r.name}" the ` +
          'one every later scan is judged by, once a person approves. Nothing was sent.',
      ].join('\n'),
    )
  },
}

// ---------------------------------------------------------------------------
// activate_icp
// ---------------------------------------------------------------------------

const activateIcpShape = {
  name: z.string().min(1).max(80).describe('The profile to make active, by name (list_icps).'),
}

export const activateIcp: AgencyToolSpec<typeof activateIcpShape> = {
  name: 'activate_icp',
  description:
    'Make one ideal-customer profile the active one — every scan from then on is scored under it — and every ' +
    'other inactive. Scores already computed keep the profile they name; a company is re-scanned (scan_company, ' +
    'rescan_stale) before its next proposal, which refuses a scan scored under another profile. An owner’s ' +
    'act, approved by a person on a card. Nothing is sent.',
  shape: activateIcpShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'agents:write')) {
      return fail('not_permitted', `Only an owner can switch the active profile. ${NOTHING_SENT}`)
    }
    const r = await activateIcpProfile(ctx.db, { orgId: ctx.orgId, actor: 'agent', name: input.name })
    if (!r.ok) {
      await ctx.audit('agent.activate_icp', { changed: false, reason: r.reason })
      return fail(r.reason === 'not_found' ? 'not_found' : 'invalid_state', `${r.message} Nothing was changed.`)
    }
    await ctx.audit('agent.activate_icp', { changed: r.changed })
    if (!r.changed) {
      return ok({ name: r.name, changed: false }, `"${r.name}" is already the active profile; nothing was changed. ${NOTHING_SENT}`)
    }
    return ok(
      { name: r.name, changed: true, previous: r.previous },
      `"${r.name}" is now the active profile${r.previous ? ` (it was "${r.previous}")` : ''}. Every scan from now ` +
        'on is scored under it; the scores already computed keep the profile they name. Before a company’s next ' +
        'proposal it needs a scan under this profile — scan_company, or rescan_stale for a few at a time. ' +
        NOTHING_SENT,
    )
  },
}
