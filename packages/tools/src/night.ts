/**
 * The night shift's run (0025), started by the worker once a night per org
 * (`apps/agent/src/night/scheduler.ts`), which holds the Google key.
 *
 * For each saved search — the one that ran longest ago first, at most
 * `NIGHT_SEARCHES_PER_RUN`, and never past the org's daily Places cap, which
 * chat's searches share — read one page of Google Maps, file every open
 * business as `add_businesses` files it (`businessFromListing`), then scan the
 * public pages of the new ones with a site of their own and ask PageSpeed how
 * each does on a phone, at most `NIGHT_SCANS_PER_RUN` and
 * `NIGHT_AUDITS_PER_RUN`. Then rank the new finds by what they need
 * (`nightRank`) and write the night's report, `night.ran`, which the
 * dashboard's morning list reads.
 *
 * It sends nothing and contacts nobody. A search Google refuses, a scan that
 * fails or a quota that runs out costs that one step, never the night, and is
 * counted in the report.
 */
import {
  NIGHT_AUDITS_PER_RUN, NIGHT_SCANS_PER_RUN, NIGHT_SEARCHES_PER_RUN, NIGHT_TOP, activeIcpProfile, addBusinesses, appendAudit,
  companyOpportunity, nightSearchesToRun, recordScan, recordSiteAudit, type AgencyDb,
} from '@agency/db'
import { isNoSiteDomain, nightRank, parseIcpDefinition } from '@agency/core'
import * as schema from '@agency/db/schema'
import { and, eq } from 'drizzle-orm'
import { scanDomain } from '@agency/scanner'
import { PAGESPEED_WORST_MS, businessFromListing, placesSearchesToday } from './opportunities.js'
import type { OpsScan, PageSpeedClient, PlacesClient } from './spec.js'

export interface NightRunResult {
  readonly searches: number
  readonly failedSearches: number
  readonly found: number
  readonly added: number
  readonly refreshed: number
  readonly scanned: number
  readonly scanFailed: number
  readonly audited: number
  readonly top: readonly string[]
  /** Each top find's needs, as keys from core's fixed list (`NEED_KEYS`), in the order of `top`. */
  readonly topNeeds: readonly (readonly string[])[]
  /** Why nothing was searched, when nothing was. */
  readonly why: 'no_searches' | 'cap_reached' | null
}

export async function runNightShift(deps: {
  readonly db: AgencyDb
  readonly orgId: string
  readonly localDate: string
  readonly now: () => Date
  readonly places: PlacesClient
  readonly pagespeed?: PageSpeedClient
  readonly scan?: OpsScan
}): Promise<NightRunResult> {
  const { db, orgId } = deps
  const searches = await nightSearchesToRun(db, orgId, NIGHT_SEARCHES_PER_RUN)
  const left = Math.max(0, deps.places.dailyLimit - (await placesSearchesToday(db, orgId, deps.now())))
  let failedSearches = 0
  let found = 0
  let refreshed = 0
  const added: { domain: string; name: string }[] = []

  for (const s of searches.slice(0, left)) {
    let returned = 0
    let addedHere = 0
    let failed = false
    try {
      const page = await deps.places.search({ query: s.query, regionCode: s.region ?? 'IN' }, AbortSignal.timeout(30_000))
      const open = page.places.filter((p) => p.status !== 'closed_permanently' && p.status !== 'closed_temporarily')
      returned = page.places.length
      found += open.length
      const india = (s.region ?? 'IN') === 'IN'
      const r = await addBusinesses(db, {
        orgId,
        businesses: open.map((l) => businessFromListing(l, { timeZone: india ? 'Asia/Kolkata' : null, country: s.region ?? 'IN', city: s.city })),
        checkedAt: deps.now(),
        actor: 'night_shift',
      })
      added.push(...r.added)
      addedHere = r.added.length
      refreshed += r.refreshed.length
    } catch {
      failed = true
      failedSearches += 1
    }
    await db.update(schema.nightSearches).set({ lastRunAt: deps.now() }).where(eq(schema.nightSearches.id, s.id))
    // Counted against the daily Places cap by `placesSearchesToday`, as chat's searches are.
    await appendAudit(db, {
      orgId, actor: 'night_shift', action: 'night.searched', subjectType: 'org', subjectId: orgId,
      detail: { searchId: s.id, returned, added: addedHere, ...(failed ? { failed: true } : {}) },
    }).catch(() => {})
  }

  // The new ones with a site of their own: their public pages, then how they do on a phone.
  const withSites = added.filter((a) => !isNoSiteDomain(a.domain))
  const companies = new Map<string, typeof schema.companies.$inferSelect>()
  for (const a of added) {
    const [c] = await db
      .select()
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.domain, a.domain)))
      .limit(1)
    if (c) companies.set(a.domain, c)
  }
  let scanned = 0
  let scanFailed = 0
  const icpRow = await activeIcpProfile(db, orgId)
  let icp: { id: string; definition: ReturnType<typeof parseIcpDefinition> } | null = null
  try {
    icp = icpRow ? { id: icpRow.id, definition: parseIcpDefinition(icpRow.definition) } : null
  } catch {
    icp = null
  }
  if (icp) {
    for (const a of withSites.slice(0, NIGHT_SCANS_PER_RUN)) {
      const c = companies.get(a.domain)
      if (!c) continue
      try {
        const { raw, profile } = await (deps.scan ?? scanDomain)(a.domain, icp.definition, { company: c.name ?? undefined })
        await recordScan(db, { orgId, companyId: c.id, icpProfile: icp, raw, profile })
        scanned += 1
      } catch {
        scanFailed += 1
      }
    }
  }
  let audited = 0
  if (deps.pagespeed) {
    for (const a of withSites.slice(0, NIGHT_AUDITS_PER_RUN)) {
      const c = companies.get(a.domain)
      if (!c) continue
      try {
        const url = `https://${a.domain}/`
        const result = await deps.pagespeed.run({ url, strategy: 'mobile' }, AbortSignal.timeout(PAGESPEED_WORST_MS))
        await recordSiteAudit(db, { orgId, companyId: c.id, strategy: 'mobile', url, result, ranAt: deps.now() })
        audited += 1
      } catch {
        // A quota or a refused key throws for every site after it: stop asking tonight.
        break
      }
    }
  }

  // The morning list: the new finds by what they need, and whether they can be called.
  const candidates = []
  for (const c of companies.values()) {
    const o = await companyOpportunity(db, { orgId, company: c, now: deps.now() })
    candidates.push({
      id: c.id,
      keys: o.reading.needs.map((n) => n.key as string),
      needs: o.reading.needs.length,
      hasPhone: c.phone !== null,
      rating: c.googleRating === null ? null : Number(c.googleRating),
      reviews: c.googleReviewCount,
    })
  }
  const ranked = nightRank(candidates, NIGHT_TOP)
  const top = ranked.map((c) => c.id)

  const result: NightRunResult = {
    searches: Math.min(searches.length, left),
    failedSearches,
    found,
    added: added.length,
    refreshed,
    scanned,
    scanFailed,
    audited,
    top,
    topNeeds: ranked.map((c) => c.keys),
    why: searches.length === 0 ? 'no_searches' : left === 0 ? 'cap_reached' : null,
  }
  await appendAudit(db, {
    orgId, actor: 'night_shift', action: 'night.ran', subjectType: 'org', subjectId: orgId,
    detail: { date: deps.localDate, ...result },
  })
  return result
}
