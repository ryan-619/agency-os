/**
 * Finding businesses that need help, and what they need (2026-10-08).
 *
 * The agency finds businesses of every kind and offers whatever helps them.
 * These tools are that work:
 *
 *  - `find_businesses` searches Google Maps — the place a customer finds a
 *    local business, with or without a website — and reports what each
 *    listing shows. It adds nothing, and is capped per org per day because
 *    every search past Google's free tier costs the agency money.
 *  - `add_businesses` files the ones chosen, with their listing details,
 *    dated. A business with no website of its own is filed under a
 *    placeholder that can never be scanned (`noSiteDomain`).
 *  - `audit_website` asks Google PageSpeed to measure a homepage from
 *    Google's side, and records what it measured — a failure is recorded as
 *    a failure, never as a slow site.
 *  - `get_opportunities` reads what a business needs, with the dated lines
 *    that show it, and the services that answer it; or ranks the whole CRM.
 *  - `list_services` reads the agency's catalogue.
 *
 * Only `add_businesses` writes a record, and it is internal: nothing here
 * reaches anybody.
 */
import { z } from 'zod'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import {
  NEED_KEYS, NEEDS, can, classifyWebsite, isNoSiteDomain, noSiteDomain, type NeedKey,
} from '@agency/core'
import {
  addBusinesses, companyOpportunity, findCompanyByDomain, isKnownTimeZone, opportunitiesAcross, recordSiteAudit,
  servicesList, type BusinessToAdd, type CompanyOpportunity, type ServiceRow,
} from '@agency/db'
import * as schema from '@agency/db/schema'
import { isScannableHost, normaliseDomain } from '@agency/scanner'
import {
  TOOL_TIME_BUDGET_MS, bounded, fail, ok, type AgencyToolSpec, type PlaceListing, type ToolContext, type ToolOutcome,
} from './spec.js'

const NOTHING_SENT = 'Nothing was sent.'

// ---------------------------------------------------------------------------
// What a search found, kept so add_businesses files exactly that
// ---------------------------------------------------------------------------

/** How long a search's listings stay available to add_businesses. */
export const LISTING_KEEP_MS = 2 * 60 * 60 * 1000
const LISTING_KEEP_MAX = 2_000

const kept = new Map<string, { readonly listing: PlaceListing; readonly at: number }>()

function keep(orgId: string, listing: PlaceListing, at: number): void {
  kept.delete(`${orgId}|${listing.placeId}`)
  kept.set(`${orgId}|${listing.placeId}`, { listing, at })
  while (kept.size > LISTING_KEEP_MAX) kept.delete(kept.keys().next().value!)
}

function keptListing(orgId: string, placeId: string, now: number): { readonly listing: PlaceListing; readonly at: number } | null {
  const hit = kept.get(`${orgId}|${placeId}`)
  if (!hit || now - hit.at > LISTING_KEEP_MS) return null
  return hit
}

/** For tests: forget every search. */
export function forgetListings(): void {
  kept.clear()
}

function websiteWords(website: string | null): string {
  const w = classifyWebsite(website)
  if (w.kind === 'none') return 'no website'
  if (w.kind === 'own') return `website ${w.host}`
  return `website is ${w.label} (${w.host})`
}

// ---------------------------------------------------------------------------
// find_businesses
// ---------------------------------------------------------------------------

const findShape = {
  query: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .describe('What and where, as a person would type it into Google Maps, e.g. "dentists in Indiranagar, Bengaluru".'),
  pageToken: z.string().max(1000).optional().describe('The next page of the same search, from a previous answer. Up to 60 results in all.'),
  onlyWithoutWebsite: z.boolean().optional().describe('List only businesses whose listing names no website of their own.'),
  region: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Two-letter country code to search from. Default IN.'),
}

async function searchesToday(ctx: ToolContext): Promise<number> {
  const now = ctx.now()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.orgId, ctx.orgId),
        eq(schema.auditLog.action, 'agent.find_businesses'),
        gte(schema.auditLog.createdAt, midnight),
      ),
    )
  return row?.n ?? 0
}

export const findBusinesses: AgencyToolSpec<typeof findShape> = {
  name: 'find_businesses',
  description:
    'Search Google Maps for businesses — "dentists in Indiranagar, Bengaluru", "boutiques in Jaipur" — and read ' +
    'what each listing shows: category, area, the website it names (or none, or only a Facebook page or a ' +
    'directory entry), rating and review count, and whether a phone is listed. Up to 20 a call. It adds nothing: ' +
    'add_businesses files the ones you choose by place id. Searches are capped per day because each costs money.',
  shape: findShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:read')) return fail('not_permitted', 'The person you are helping cannot read companies.')
    if (!ctx.places) {
      return fail(
        'unreachable',
        'Google Maps search is not switched on for this worker: the person running it adds a Google API key with ' +
          '`./tools/run-worker.sh --google` (Places API enabled on that key). Until then, find businesses with the ' +
          'research connectors and add them with add_company. Nothing was searched.',
      )
    }
    const used = await searchesToday(ctx)
    if (used >= ctx.places.dailyLimit) {
      return fail(
        'invalid_state',
        `Today's ${ctx.places.dailyLimit} Google Maps searches are used up — each costs the agency money past Google's free ` +
          'tier. Search again tomorrow, or use the research connectors meanwhile. Nothing was searched.',
      )
    }

    let page: Awaited<ReturnType<NonNullable<ToolContext['places']>['search']>>
    try {
      page = await ctx.places.search(
        { query: input.query, ...(input.pageToken ? { pageToken: input.pageToken } : {}), regionCode: (input.region ?? 'IN').toUpperCase() },
        AbortSignal.timeout(TOOL_TIME_BUDGET_MS),
      )
    } catch (err) {
      await ctx.audit('agent.find_businesses', { returned: 0, failed: true })
      return fail('unreachable', `Google Maps did not answer: ${err instanceof Error ? err.message : 'an unknown fault'}. Nothing was added.`)
    }
    const at = ctx.now().getTime()
    for (const listing of page.places) keep(ctx.orgId, listing, at)

    // What is already here, by place or by the domain the listing names.
    const placeIds = page.places.map((p) => p.placeId)
    const domains = page.places
      .map((p) => classifyWebsite(p.website))
      .filter((w) => w.kind === 'own' && w.host)
      .map((w) => normaliseDomain(w.host!))
      .filter((d): d is string => Boolean(d))
    const known =
      placeIds.length || domains.length
        ? await ctx.db
            .select({ domain: schema.companies.domain, placeId: schema.companies.googlePlaceId })
            .from(schema.companies)
            .where(
              and(
                eq(schema.companies.orgId, ctx.orgId),
                sql`(${placeIds.length ? inArray(schema.companies.googlePlaceId, placeIds) : sql`false`} OR ${domains.length ? inArray(schema.companies.domain, domains) : sql`false`})`,
              ),
            )
        : []
    const knownBy = (p: PlaceListing): string | null => {
      const host = classifyWebsite(p.website)
      const domain = host.kind === 'own' && host.host ? normaliseDomain(host.host) : null
      return known.find((k) => k.placeId === p.placeId || (domain !== null && k.domain === domain))?.domain ?? null
    }

    const shown = page.places.filter((p) => !input.onlyWithoutWebsite || classifyWebsite(p.website).kind !== 'own')
    const withoutSite = page.places.filter((p) => classifyWebsite(p.website).kind !== 'own').length
    await ctx.audit('agent.find_businesses', { returned: page.places.length, withoutWebsite: withoutSite, more: page.nextPageToken !== null })

    const lines = shown.map((p, i) => {
      const parts = [
        p.name,
        p.category?.replace(/_/g, ' ') ?? null,
        p.address,
        websiteWords(p.website),
        p.rating !== null ? `★${p.rating.toFixed(1)}${p.reviews !== null ? ` (${p.reviews} reviews)` : ''}` : 'no rating',
        p.phone ? 'phone listed' : 'no phone listed',
        p.status === 'closed_permanently' ? 'PERMANENTLY CLOSED — skip' : p.status === 'closed_temporarily' ? 'temporarily closed' : null,
      ].filter((x): x is string => Boolean(x))
      const here = knownBy(p)
      return `  ${i + 1}. ${parts.join(' — ')}${here ? ` — already in the CRM as ${here}` : ''} · place ${p.placeId}`
    })
    return ok(
      { returned: page.places.length, shown: shown.length, withoutWebsite: withoutSite, nextPageToken: page.nextPageToken },
      bounded([
        `Google Maps, "${input.query}": ${page.places.length} businesses, ${withoutSite} without a website of their own` +
          `${input.onlyWithoutWebsite ? ` (showing those ${shown.length})` : ''}. ` +
          `${Math.max(0, ctx.places.dailyLimit - used - 1)} of today's ${ctx.places.dailyLimit} searches left.`,
        ...lines,
        page.nextPageToken ? `More: call again with pageToken "${page.nextPageToken}".` : 'That is every result Google gives for this search.',
        'Listings are Google’s record as of now, not our observation. Nothing was added: add_businesses files the ones ' +
          `you choose by place id (kept for two hours). ${NOTHING_SENT}`,
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// add_businesses
// ---------------------------------------------------------------------------

const addShape = {
  placeIds: z.array(z.string().min(5).max(300)).min(1).max(20).describe('Place ids from find_businesses, at most 20.'),
  timeZone: z.string().max(64).optional().describe('IANA zone for all of them, e.g. "Asia/Kolkata". Default: none recorded.'),
  country: z.string().max(60).optional().describe('Their country, e.g. "India".'),
  city: z.string().max(80).optional().describe('Their city, e.g. "Bengaluru".'),
}

export const addBusinessesTool: AgencyToolSpec<typeof addShape> = {
  name: 'add_businesses',
  description:
    'File businesses found with find_businesses in the CRM, by place id, with what their listing shows — phone, ' +
    'address, rating, reviews, category, the website it names — dated. One with a website of its own is filed by ' +
    'its domain (scan it and audit it next); one without is filed under a placeholder that is never scanned. ' +
    'Already here: its listing is refreshed. Neither scans nor contacts anybody. Nothing is sent.',
  shape: addShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:write')) return fail('not_permitted', 'The person you are helping cannot add companies.')
    if (input.timeZone && !isKnownTimeZone(input.timeZone)) {
      return fail('invalid_state', `"${input.timeZone}" is not a time zone this server knows, e.g. Asia/Kolkata. Nothing was added.`)
    }
    const now = ctx.now()
    const businesses: BusinessToAdd[] = []
    const missing: string[] = []
    let checkedAt = now
    for (const placeId of [...new Set(input.placeIds)]) {
      const hit = keptListing(ctx.orgId, placeId, now.getTime())
      if (!hit) {
        missing.push(placeId)
        continue
      }
      const l = hit.listing
      if (hit.at < checkedAt.getTime()) checkedAt = new Date(hit.at)
      const site = classifyWebsite(l.website)
      const own = site.kind === 'own' && site.host ? normaliseDomain(site.host) : null
      const domain = own && isScannableHost(own) ? own : noSiteDomain(l.name, `place:${l.placeId}`)
      businesses.push({
        domain, name: l.name, placeId: l.placeId, address: l.address, phone: l.phone, website: l.website,
        rating: l.rating, reviews: l.reviews, category: l.category, mapsUrl: l.mapsUrl,
        timeZone: input.timeZone ?? null, country: input.country ?? null, city: input.city ?? null,
      })
    }
    if (businesses.length === 0) {
      return fail(
        'not_found',
        `None of those place ids is from a search in the last two hours. Search again with find_businesses, then add. Nothing was added.`,
      )
    }
    const r = await addBusinesses(ctx.db, { orgId: ctx.orgId, businesses, checkedAt, actor: 'agent' })
    await ctx.audit('agent.add_businesses', { asked: input.placeIds.length, added: r.added.length, refreshed: r.refreshed.length, missing: missing.length })
    const describe = (domain: string, name: string | null) =>
      isNoSiteDomain(domain) ? `${name ?? 'a business'} — no website of its own (filed as ${domain})` : `${name ?? domain} — ${domain}`
    const withSite = r.added.filter((a) => !isNoSiteDomain(a.domain)).length
    return ok(
      { added: r.added, refreshed: r.refreshed, missing },
      bounded([
        `Added ${r.added.length} ${r.added.length === 1 ? 'business' : 'businesses'} from Google Maps${r.refreshed.length ? `, refreshed ${r.refreshed.length} already here` : ''}.`,
        ...r.added.map((a) => `  + ${describe(a.domain, a.name)}`),
        ...r.refreshed.map((a) => `  ~ ${describe(a.domain, a.name)} (listing refreshed)`),
        ...(missing.length ? [`Not from a recent search, so not added: ${missing.join(', ')}.`] : []),
        withSite > 0
          ? `Next: scan_company and audit_website for the ${withSite} with a website, then get_opportunities.`
          : 'Next: get_opportunities shows what they need.',
        `No consent was recorded and nobody was contacted. ${NOTHING_SENT}`,
      ]),
    )
  },
}

// ---------------------------------------------------------------------------
// audit_website
// ---------------------------------------------------------------------------

/** How long a PageSpeed run may take before it is abandoned, unrecorded. */
export const PAGESPEED_WORST_MS = 120_000

const auditShape = {
  domain: z.string().min(1).max(253).describe('The company’s domain, as the CRM holds it.'),
  strategy: z.enum(['mobile', 'desktop']).optional().describe('Measure as a phone or a desktop. Default mobile — most visits are on phones.'),
}

const running = new Set<string>()

function withLimit<T>(work: Promise<T>, ms: number): Promise<T | 'still_running'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<'still_running'>((resolve) => {
      timer = setTimeout(() => resolve('still_running'), ms)
      timer.unref?.()
    }),
  ])
}

export function makeAuditWebsite(opts: { readonly deadlineMs?: number } = {}): AgencyToolSpec<typeof auditShape> {
  const deadline = opts.deadlineMs ?? TOOL_TIME_BUDGET_MS
  return {
    name: 'audit_website',
    description:
      'Ask Google PageSpeed Insights to measure a company’s homepage from Google’s side, like any visitor — ' +
      'performance, SEO, accessibility and best practices, with load times — and record what it measured. A page ' +
      'Google could not load is recorded as that, never as a slow site. Takes up to a minute; a run still going ' +
      'when this answers records itself when it finishes. Nothing is sent.',
    shape: auditShape,
    async handler(input, ctx): Promise<ToolOutcome<unknown>> {
      const domain = normaliseDomain(input.domain)
      if (!domain) return fail('invalid_state', `"${input.domain}" is not a domain.`)
      const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
      if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)
      if (isNoSiteDomain(company.domain)) {
        return fail('invalid_state', `${company.name ?? 'That business'} has no website of its own to measure. Nothing was run.`)
      }
      if (!ctx.pagespeed) return fail('unreachable', 'PageSpeed is not available on this worker. Nothing was run.')
      const strategy = input.strategy ?? 'mobile'
      const key = `${ctx.orgId}|${company.id}|${strategy}`
      if (running.has(key)) {
        return ok({ domain, status: 'already_running' }, `A ${strategy} PageSpeed run for ${domain} is already going; it records itself when it finishes. ${NOTHING_SENT}`)
      }
      const url = `https://${company.domain}/`
      running.add(key)
      const work = (async () => {
        try {
          const result = await ctx.pagespeed!.run({ url, strategy }, AbortSignal.timeout(PAGESPEED_WORST_MS))
          return await recordSiteAudit(ctx.db, { orgId: ctx.orgId, companyId: company.id, strategy, url, result, ranAt: ctx.now() })
        } finally {
          running.delete(key)
        }
      })()
      // A run still going when the call answers keeps going, and records itself; its failure is not the turn's.
      work.catch(() => {})
      let done: Awaited<typeof work> | 'still_running'
      try {
        done = await withLimit(work, deadline)
      } catch (err) {
        await ctx.audit('agent.audit_website', { domain, strategy, outcome: 'unavailable' })
        return fail('unreachable', `PageSpeed did not answer: ${err instanceof Error ? err.message : 'an unknown fault'}. Nothing was recorded.`)
      }
      if (done === 'still_running') {
        await ctx.audit('agent.audit_website', { domain, strategy, outcome: 'still_running' })
        return ok(
          { domain, status: 'still_running' },
          `PageSpeed is still measuring ${domain} (${strategy}) — it records itself when it finishes, within ` +
            `${PAGESPEED_WORST_MS / 60_000} minutes; read it then with get_opportunities. ${NOTHING_SENT}`,
        )
      }
      await ctx.audit('agent.audit_website', { domain, strategy, outcome: done.ok ? 'measured' : 'not_loaded' })
      if (!done.ok) {
        return ok(
          { domain, status: 'not_loaded', error: done.error },
          `PageSpeed could not measure ${domain} (${strategy}): ${done.error}. That is recorded as a failed audit — not a slow ` +
            `site; do not describe it as one. ${NOTHING_SENT}`,
        )
      }
      const secs = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toFixed(1)} s`)
      return ok(
        { domain, status: 'measured', audit: done },
        [
          `PageSpeed measured ${domain} as a ${strategy} visitor on ${done.ranAt.toISOString().slice(0, 10)}:`,
          `  performance ${done.performance ?? '—'}/100 · SEO ${done.seo ?? '—'}/100 · accessibility ${done.accessibility ?? '—'}/100 · best practices ${done.bestPractices ?? '—'}/100`,
          `  main content shown after ${secs(done.lcpMs) ?? '—'} · first content after ${secs(done.fcpMs) ?? '—'} · layout shift ${done.cls ?? '—'}` +
            `${done.fieldCategory ? ` · real Chrome users: ${done.fieldCategory.toLowerCase()}` : ''}`,
          `Recorded; quote it dated, while current. ${NOTHING_SENT}`,
        ].join('\n'),
      )
    },
  }
}

export const auditWebsite = makeAuditWebsite()

/** For tests: nothing is running. */
export function forgetRunningAudits(): void {
  running.clear()
}

// ---------------------------------------------------------------------------
// get_opportunities and list_services
// ---------------------------------------------------------------------------

const UNIT_WORDS: Readonly<Record<string, string>> = {
  one_off: 'one-off', monthly: 'a month', yearly: 'a year', hourly: 'an hour', daily: 'a day',
}

export function priceWords(s: Pick<ServiceRow, 'priceFrom' | 'priceTo' | 'currency' | 'priceUnit'>): string | null {
  const n = (v: number) => v.toLocaleString(s.currency === 'INR' ? 'en-IN' : 'en')
  const unit = UNIT_WORDS[s.priceUnit] ?? s.priceUnit
  if (s.priceFrom !== null && s.priceTo !== null) {
    return s.priceFrom === s.priceTo ? `${s.currency} ${n(s.priceFrom)} ${unit}` : `${s.currency} ${n(s.priceFrom)}–${n(s.priceTo)} ${unit}`
  }
  if (s.priceFrom !== null) return `from ${s.currency} ${n(s.priceFrom)} ${unit}`
  if (s.priceTo !== null) return `up to ${s.currency} ${n(s.priceTo)} ${unit}`
  return null
}

const needWords = (keys: readonly NeedKey[]) => keys.map((k) => NEEDS[k].label.toLowerCase()).join(', ')

function companyName(o: CompanyOpportunity): string {
  const c = o.company
  return isNoSiteDomain(c.domain) ? `${c.name ?? 'a business'} (no website of its own)` : `${c.name ? `${c.name} — ` : ''}${c.domain}`
}

const opportunitiesShape = {
  domain: z.string().min(1).max(253).optional().describe('One company, by its domain as the CRM holds it. Omit to rank the whole CRM.'),
  need: z.enum(NEED_KEYS).optional().describe('Only businesses showing this need, when ranking.'),
  service: z.string().max(80).optional().describe('Only businesses a service of this name answers, when ranking.'),
  limit: z.number().int().min(1).max(25).optional().describe('How many to rank. Default 10, at most 25.'),
}

export const getOpportunities: AgencyToolSpec<typeof opportunitiesShape> = {
  name: 'get_opportunities',
  description:
    'Read what a business needs — no website, only a Facebook page, not mobile-friendly, slow, weak search basics, ' +
    'no WhatsApp, hard to contact, few or poor Google reviews, website security gaps and more — each with the dated ' +
    'lines that show it, what could not be assessed, and the agency’s services that answer it. With no domain, ranks ' +
    'the whole CRM by how much each business needs. A read; it changes and sends nothing.',
  shape: opportunitiesShape,
  async handler(input, ctx): Promise<ToolOutcome<unknown>> {
    if (!can(ctx.principal, 'companies:read')) return fail('not_permitted', 'The person you are helping cannot read companies.')
    const now = ctx.now()
    const catalogue = await servicesList(ctx.db, ctx.orgId, { activeOnly: true })
    const price = (id: string | null) => {
      const s = id ? catalogue.find((c) => c.id === id) : null
      return s ? priceWords(s) : null
    }

    if (input.domain) {
      const domain = normaliseDomain(input.domain) ?? input.domain.trim().toLowerCase()
      const company = await findCompanyByDomain(ctx.db, ctx.orgId, domain)
      if (!company) return fail('not_found', `No company with domain "${domain}" is in the CRM.`)
      const o = await companyOpportunity(ctx.db, { orgId: ctx.orgId, company, now })
      await ctx.audit('agent.get_opportunities', { companies: 1, needs: o.reading.needs.length })
      const c = o.company
      const listing = c.listingCheckedAt
        ? `Google listing (read ${c.listingCheckedAt.toISOString().slice(0, 10)}): ${[
            c.googleCategory?.replace(/_/g, ' '),
            c.googleRating !== null ? `★${Number(c.googleRating).toFixed(1)} from ${c.googleReviewCount ?? 0} reviews` : null,
            c.phone ? 'phone on record' : 'no phone on record',
            c.address,
          ].filter(Boolean).join(' · ')}`
        : 'No Google listing on record.'
      return ok(
        { domain: c.domain, needs: o.reading.needs, notAssessed: o.reading.notAssessed, services: o.services },
        bounded([
          `${companyName(o)} — website: ${o.reading.website.label}${o.reading.website.host ? ` (${o.reading.website.host})` : ''}.`,
          listing,
          o.reading.needs.length ? `Needs (${o.reading.needs.length}) — each line is quotable while current, dated as shown:` : 'No needs established from what is on record.',
          ...o.reading.needs.flatMap((n) => [`  • ${n.label}`, ...n.evidence.map((e) => `      ${e}`)]),
          ...(o.services.length
            ? [
                o.services[0]!.suggested
                  ? 'Services that would answer them (SUGGESTIONS — the agency has no catalogue yet; Settings → Services):'
                  : 'Services that answer them:',
                ...o.services.map((s) => `  • ${s.name} — answers ${needWords(s.answers)}${price(s.id) ? ` — ${price(s.id)}` : ''}`),
              ]
            : []),
          ...(o.reading.notAssessed.length ? ['Not assessed — do not claim these either way:', ...o.reading.notAssessed.map((n) => `  • ${n}`)] : []),
          `A read. ${NOTHING_SENT}`,
        ]),
      )
    }

    const serviceId = input.service
      ? catalogue.find((s) => s.name.toLowerCase() === input.service!.trim().toLowerCase())?.id
      : undefined
    if (input.service && !serviceId) {
      return fail('not_found', `No active service called "${input.service}" is in the catalogue — list_services shows them.`)
    }
    const all = await opportunitiesAcross(ctx.db, { orgId: ctx.orgId, now, need: input.need, serviceId })
    const top = all.results.slice(0, input.limit ?? 10)
    await ctx.audit('agent.get_opportunities', { companies: all.read, matched: all.results.length, returned: top.length })
    return ok(
      { read: all.read, matched: all.results.length, results: top.map((o) => ({ domain: o.company.domain, needs: o.reading.needs.map((n) => n.key), services: o.services.map((s) => s.name) })) },
      bounded([
        `${all.results.length} of the ${all.read} companies read show a need${input.need ? ` (${NEEDS[input.need].label.toLowerCase()})` : ''}` +
          `${input.service ? ` a service called “${input.service}” answers` : ''}; the most first:`,
        ...top.map((o, i) =>
          `  ${i + 1}. ${companyName(o)} — needs: ${o.reading.needs.map((n) => n.label.toLowerCase()).join(', ')}` +
            `${o.services[0] ? ` — fits: ${o.services[0].name}${o.services[0].suggested ? ' (suggested)' : ''}` : ''}`,
        ),
        'Read one with get_opportunities and its domain for the dated evidence before pitching anything.',
        `A read. ${NOTHING_SENT}`,
      ]),
    )
  },
}

export const listServices: AgencyToolSpec<Record<string, never>> = {
  name: 'list_services',
  description:
    'Read the agency’s services catalogue — each service, its price range and the needs it answers — as kept in ' +
    'Settings → Services. Pitch these, at these prices; never invent a service or a price. A read.',
  shape: {},
  async handler(_input, ctx): Promise<ToolOutcome<unknown>> {
    const catalogue = await servicesList(ctx.db, ctx.orgId)
    await ctx.audit('agent.list_services', { services: catalogue.length })
    if (catalogue.length === 0) {
      return ok(
        { services: [] },
        'The agency has no services catalogue yet. An owner adds one in Settings → Services (there is a suggested set ' +
          'to start from). Until then, describe what the agency does from its playbook, with no prices. A read.',
      )
    }
    return ok(
      { services: catalogue.map((s) => ({ id: s.id, name: s.name, active: s.active, needs: s.needs })) },
      bounded([
        `The agency's services (${catalogue.length}):`,
        ...catalogue.map(
          (s) =>
            `  • ${s.name}${s.active ? '' : ' (switched off)'}${priceWords(s) ? ` — ${priceWords(s)}` : ' — no price set'}` +
            `${s.needs.length ? ` — answers ${s.needs.map((k) => (NEEDS as Record<string, { label: string }>)[k]?.label.toLowerCase() ?? k).join(', ')}` : ''}` +
            `${s.description ? `\n      ${s.description}` : ''}`,
        ),
        'A read; nothing was changed.',
      ]),
    )
  },
}
