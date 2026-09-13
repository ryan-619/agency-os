/**
 * The tools that change something.
 *
 * Two of them write evidence — a scan and the score derived from it — and are
 * classified `low`, because §5.4 lists "run a scan" under low in so many words
 * and because everything they record is an observation rather than an action.
 * The third drafts a message intended for someone outside the company, and is
 * the one high-risk tool Phase 2 ships.
 */
import { z } from 'zod'
import { DEFAULT_STALE_AFTER_DAYS, isStale, parseIcpDefinition, type IcpDefinition } from '@agency/core'
import {
  activeIcpProfile, findCompanyByDomain, importCompanies, latestScanWithFindings,
  recordScan, type AgencyDb,
} from '@agency/db'
import { UnscannableHostError, normaliseDomain, scanDomain } from '@agency/scanner'
import * as schema from '@agency/db/schema'
import { bounded, fail, ok, type AgencyToolSpec, type ToolContext, type ToolOutcome } from './spec.js'

async function requireIcp(
  db: AgencyDb,
  orgId: string,
): Promise<{ id: string; definition: IcpDefinition } | null> {
  const row = await activeIcpProfile(db, orgId)
  if (!row) return null
  try {
    return { id: row.id, definition: parseIcpDefinition(row.definition) }
  } catch {
    return null
  }
}

/**
 * Scan one domain and write what came back.
 *
 * Shared by `scan_company` and by `score_company`'s re-scan path, so there is
 * exactly one writer of a scan and its score. `recordScan` computes the score
 * itself from the ICP row it stamps, inside one transaction, which is what
 * makes it impossible for the scan, its findings and its score to disagree.
 */
async function scanAndRecord(
  ctx: ToolContext,
  domain: string,
  companyId: string,
  companyName: string | null,
  icp: { id: string; definition: IcpDefinition },
) {
  const { raw, profile } = await scanDomain(domain, icp.definition, {
    company: companyName ?? undefined,
  })
  return recordScan(ctx.db, {
    orgId: ctx.orgId,
    companyId,
    icpProfile: icp,
    raw,
    profile,
  })
}

// ---------------------------------------------------------------------------
// scan_company
// ---------------------------------------------------------------------------

const scanShape = {
  domain: z.string().min(1).max(253).describe('The company\'s own domain, e.g. "example.com".'),
  name: z.string().max(200).optional().describe('Company name, if it is not already in the CRM.'),
}

export const scanCompany: AgencyToolSpec<typeof scanShape> = {
  name: 'scan_company',
  description:
    'Request a company\'s own public pages — its homepage, the conventional public paths like ' +
    '/security and /.well-known/security.txt, and its TLS certificate — and record what came ' +
    'back, then score it against the ICP. This is posture review from the outside, not a ' +
    'security test: nothing private is accessed and no port is scanned. Adds the company to the ' +
    'CRM if it is not already there.',
  shape: scanShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    if (!domain) return fail('invalid_state', `"${input.domain}" is not a domain.`)

    const icp = await requireIcp(ctx.db, ctx.orgId)
    if (!icp) return fail('invalid_state', 'No active ICP profile, so there is nothing to score against.')

    let company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) {
      // Source: 'agent', so the CRM records that a model put this row here.
      await importCompanies(ctx.db, ctx.orgId, [{ domain, name: input.name }], 'agent')
      company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    }
    if (!company) return fail('invalid_state', `Could not add "${domain}" to the CRM.`)

    try {
      const { result, scanId } = await scanAndRecord(ctx, domain, company.id, company.name, icp)
      await ctx.audit('agent.scan_company', { domain, scanId, score: result.score })

      if (!result.reachable) {
        return ok(
          { domain, reachedTheSite: false, error: result.fetchError, score: 0 },
          `The scan of ${domain} never reached the site (${result.fetchError || 'no response'}). ` +
            'Nothing was observed, so nothing can be claimed about their posture.',
        )
      }
      return ok(
        {
          domain,
          reachedTheSite: true,
          score: result.score,
          tier: result.tier,
          qualified: result.qualified,
          disqualifiedReason: result.disqualified,
          gaps: result.gaps.map((g) => ({ signal: g.key, weight: g.weight, detail: g.detail })),
        },
        bounded([
          `${domain} scored ${result.score}/100` +
            (result.disqualified ? ` — disqualified: ${result.disqualified}` : `, ${result.tier || 'below threshold'}`),
          ...result.gaps.map((g) => `  ${String(g.weight).padStart(2)}  ${g.key} — ${g.detail || 'absent'}`),
        ]),
      )
    } catch (err) {
      // The one refusal worth naming explicitly: the scanner will not be
      // pointed at anything that is not a public site, and a model-supplied
      // domain is exactly the untrusted input that check exists for.
      if (err instanceof UnscannableHostError) {
        return fail('not_permitted', err.message)
      }
      return fail('unreachable', err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  },
}

// ---------------------------------------------------------------------------
// score_company
// ---------------------------------------------------------------------------

const scoreShape = {
  domain: z.string().min(1).max(253),
  forceRescan: z.boolean().optional().describe('Re-scan even if the current evidence is fresh.'),
}

export const scoreCompanyTool: AgencyToolSpec<typeof scoreShape> = {
  name: 'score_company',
  description:
    'Make sure a company has a current score, and return it. If the last scan is recent enough ' +
    'the stored score is returned unchanged; if the evidence has aged out or the company has ' +
    'never been scanned, it is scanned again first. Use this when you need a number you are ' +
    'about to rely on, rather than one that merely exists.',
  shape: scoreShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)

    const icp = await requireIcp(ctx.db, ctx.orgId)
    if (!icp) return fail('invalid_state', 'No active ICP profile, so there is nothing to score against.')
    const days = icp.definition.freshness?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS

    const found = await latestScanWithFindings(ctx.db, ctx.orgId, company.id)
    const fresh =
      found !== null && found.scan.ok && !isStale(found.scan.ranAt, days, ctx.now()) && found.score !== null

    if (fresh && !input.forceRescan) {
      const score = found.score!
      await ctx.audit('agent.score_company', { domain, rescanned: false, score: score.score })
      return ok(
        {
          domain, rescanned: false, score: score.score, tier: score.tier,
          qualified: score.qualified, disqualifiedReason: score.disqualifiedReason,
          scanRanAt: found.scan.ranAt.toISOString(),
        },
        `${domain} scored ${score.score}/100${score.tier ? `, ${score.tier}` : ''}, from a scan on ` +
          `${found.scan.ranAt.toISOString().slice(0, 10)} that is still current.`,
      )
    }

    try {
      const { result } = await scanAndRecord(ctx, domain, company.id, company.name, icp)
      await ctx.audit('agent.score_company', { domain, rescanned: true, score: result.score })
      const why = found === null ? 'it had never been scanned' : 'its evidence had aged out'
      return ok(
        {
          domain, rescanned: true, score: result.score, tier: result.tier,
          qualified: result.qualified, disqualifiedReason: result.disqualified,
        },
        result.reachable
          ? `Re-scanned ${domain} because ${why}. It scores ${result.score}/100` +
            (result.disqualified ? ` — disqualified: ${result.disqualified}.` : `, ${result.tier || 'below threshold'}.`)
          : `Tried to re-scan ${domain} because ${why}, but the site did not respond ` +
            `(${result.fetchError || 'no response'}). Nothing was observed.`,
      )
    } catch (err) {
      if (err instanceof UnscannableHostError) return fail('not_permitted', err.message)
      return fail('unreachable', err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  },
}

// ---------------------------------------------------------------------------
// queue_touch — the one high-risk tool
// ---------------------------------------------------------------------------

const touchShape = {
  domain: z.string().min(1).max(253).describe('The company this message is about.'),
  /**
   * §2.1: cold outreach is email and LinkedIn ONLY. This enum is the guard
   * BELOW the approval gate — it holds even if `canUseTool` never ran, which
   * is the difference between a rule and a configuration.
   */
  channel: z.enum(['email', 'linkedin']),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
}

export const queueTouch: AgencyToolSpec<typeof touchShape> = {
  name: 'queue_touch',
  description:
    'Draft an outbound message about a company and put it in the approval queue. It is NOT sent: ' +
    'a human reads it and decides, and nothing in this system can send anything yet. Email and ' +
    'LinkedIn only. Quote only findings you have read from get_company that are marked quotable.',
  shape: touchShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    const domain = normaliseDomain(input.domain)
    const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
    if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)

    const rows = await ctx.db
      .insert(schema.touches)
      .values({
        orgId: ctx.orgId,
        // What the draft is ABOUT (0008). No contact and no recipient: Phase 2
        // has no contacts and no consent records, and a draft addressed to
        // nobody cannot be sent to anybody.
        companyId: company.id,
        contactId: null,
        recipient: null,
        channel: input.channel,
        direction: 'out',
        // Deliberately NOT the column default 'queued': that is the value a
        // Phase 4 sender would scan for, and this row must never be picked up
        // by one. It is a draft awaiting a person.
        status: 'awaiting_approval',
        subject: input.subject,
        body: input.body,
      })
      .returning({ id: schema.touches.id })

    const touchId = rows[0]?.id
    if (!touchId) return fail('invalid_state', 'Could not record the draft.')

    await ctx.audit('agent.queue_touch', { domain, channel: input.channel, touchId })
    return ok(
      { touchId, domain, channel: input.channel, status: 'awaiting_approval' },
      `Drafted a ${input.channel} message about ${domain} and put it in the approval queue. ` +
        'It has no recipient and has not been sent; a person has to read it and decide.',
    )
  },
}
