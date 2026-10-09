import { NextResponse } from 'next/server'
import { parseIcpDefinition } from '@agency/core'
import {
  RESCAN_SCAN_TIMEOUTS, SHARE_LINK_TTL_DAYS, activeIcpProfile, orgByBookingSlug, recordScan, shareLinkMint, websiteCheckRequest,
  type AgencyDb,
} from '@agency/db/queries'
import { isScannableHost, normaliseDomain, scanDomain } from '@agency/scanner'
import { checkConsentWording } from '@/lib/check-copy'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * The public free website check (2026-10-08): a stranger's request, so the
 * booking endpoint's rules — no session (`/api/check` is public in
 * `proxy.ts`), a bounded body, the org found by its booking slug, nothing
 * enumerable returned — plus a cap per hour and per site
 * (`websiteCheckRequest`), a box that must be ticked, and a field no person
 * fills (a form-filling robot does).
 *
 * The site is read from the outside like any scan — its public pages only,
 * at the nightly rescan's timeouts, and only at a public address (the
 * scanner checks each connection, `publicOnlyLookup`) — within
 * `SCAN_BUDGET_MS`; one that takes longer records nothing, and the page says
 * what it could not check. The answer is a link to the business's own audit
 * page, made for nobody on the team: its first view gives the team the task
 * to call.
 *
 * A site or an address already on file gets none of that (review,
 * 2026-10-08): `websiteCheckRequest` records it with a task for a person to
 * confirm who asked, and this route answers the thank-you alone — no scan,
 * no link — because anybody can type a prospect's domain or a contact's
 * address, and the agency's findings about them are not a stranger's to
 * read. Stated residual: whether the page opens at once tells a visitor
 * whether a site is new here, at most `CHECKS_PER_HOUR` sites an hour.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_BODY = 4 * 1024
const SCAN_BUDGET_MS = 25_000

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) || null : null
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await context.params
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return NextResponse.json({ error: 'This page is not active.' }, { status: 404 })
  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let b: Record<string, unknown>
  try {
    b = (JSON.parse(raw) ?? {}) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  // A field the form hides from people: only a robot fills it. Answered like success, and nothing is done.
  if (text(b.website_confirm, 200)) return NextResponse.json({ ok: true, url: null }, { status: 202 })
  if (b.consent !== true) return NextResponse.json({ error: 'Please tick the box so we can send you the result.' }, { status: 400 })
  const site = text(b.website, 300)
  const name = text(b.name, 120)
  const email = text(b.email, 254)
  if (!site) return NextResponse.json({ error: 'Which website should we check?' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'Please tell us your name.' }, { status: 400 })
  if (!email) return NextResponse.json({ error: 'Please give us an email address for the result.' }, { status: 400 })
  const domain = normaliseDomain(site)
  if (!domain || !isScannableHost(domain)) {
    return NextResponse.json({ error: 'That does not look like a public website address, like yourbusiness.com.' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const org = await orgByBookingSlug(db, slug)
  if (!org) return NextResponse.json({ error: 'This page is not active.' }, { status: 404 })
  const now = new Date()
  let r
  try {
    r = await websiteCheckRequest(db, {
      slug, domain, businessName: text(b.business, 120), name, email, timeZone: text(b.timeZone, 64),
      consentWording: checkConsentWording(org.name), now,
    })
  } catch (err) {
    log.error('website check could not be recorded', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'That could not be recorded just now. Please try again in a few minutes.' }, { status: 500 })
  }
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  // On file already: recorded, with a task to confirm who asked. Nothing is scanned and no page is made.
  if (r.recognised) return NextResponse.json({ ok: true, url: null }, { status: 201 })

  // Read the site, bounded: a slow one costs the visitor the lines we could not check, never the page.
  try {
    const icpRow = await activeIcpProfile(db, r.orgId)
    if (icpRow) {
      const icp = { id: icpRow.id, definition: parseIcpDefinition(icpRow.definition) }
      let timer: ReturnType<typeof setTimeout> | undefined
      const scanned = await Promise.race([
        scanDomain(domain, icp.definition, { company: text(b.business, 120) ?? undefined, ...RESCAN_SCAN_TIMEOUTS }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SCAN_BUDGET_MS) }),
      ]).finally(() => clearTimeout(timer))
      if (scanned) await recordScan(db, { orgId: r.orgId, companyId: r.companyId, icpProfile: icp, raw: scanned.raw, profile: scanned.profile })
    }
  } catch (err) {
    log.warn('website check scan did not finish', { error: err instanceof Error ? err.name : 'UnknownError' })
  }

  try {
    const { token } = await shareLinkMint(db, {
      orgId: r.orgId, kind: 'report', companyId: r.companyId, createdBy: null, actor: 'website_check',
      expiresAt: new Date(now.getTime() + SHARE_LINK_TTL_DAYS * 86_400_000),
    })
    // A path, not an id: the visitor's own page, which is theirs to keep.
    return NextResponse.json({ ok: true, url: `/r/${token}` }, { status: 201 })
  } catch (err) {
    log.error('website check link could not be made', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ ok: true, url: null }, { status: 201 })
  }
}
