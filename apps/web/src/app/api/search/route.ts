import { NextResponse } from 'next/server'
import { searchOrg, searchQueryFrom, searchSectionsFor, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * The sidebar box: companies, people, deals, meetings, proposals, campaigns
 * and messages by text, within the caller's org and within what they may see.
 *
 * There is no `search` capability. Each section is gated by the capability
 * that already gates reading that table (`searchSectionsFor`), so a member
 * missing one gets no rows from that section rather than a 403 — the answer
 * is the union of what they may read. A principal who may read none of it is
 * refused outright. No role today is that principal; the branch exists so
 * the gate is visible here rather than implied by the roles.
 *
 * `q` is CONTENT (§2.3). People paste phone numbers, addresses and sign-in
 * links into a search box, and `redact()` keys off field names, not values —
 * so the query is never logged, and neither is a driver error, whose message
 * can quote the query's parameters. The log line says how long the query was
 * and how much came back. A read is not audited, here or anywhere in the app.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

/** The answer names people and quotes subjects; nothing between here and the browser keeps it. */
const NO_STORE = { 'cache-control': 'no-store' }

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sections = searchSectionsFor({ id: user.id, orgId: user.orgId, role: user.role })
  if (!sections) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const parsed = searchQueryFrom(new URL(request.url).searchParams.get('q'))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  let result
  try {
    result = await searchOrg(getDb() as unknown as AgencyDb, user.orgId, parsed.q, sections)
  } catch (err) {
    log.error('search failed', { length: parsed.q.length, error: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json({ error: 'The search did not complete. Try again.' }, { status: 500, headers: NO_STORE })
  }

  log.info('search', { length: parsed.q.length, hits: result.hits.length, truncated: result.truncated })
  // `q` goes back as it was run (trimmed, collapsed), so the box can tell
  // this answer from the one to a query the person has since typed past.
  return NextResponse.json({ q: parsed.q, hits: result.hits, truncated: result.truncated }, { headers: NO_STORE })
}
