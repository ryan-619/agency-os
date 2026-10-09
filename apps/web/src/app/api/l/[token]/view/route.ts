import { and, eq } from 'drizzle-orm'
import { SHARE_LINK_TOKEN_SHAPE, schema, shareLinkCountView, shareLinkResolve, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { isRobotAgent, linkKindOf } from '@/lib/link-view'
import { log } from '@/lib/logger'
import { viewerIsTeam } from '@/lib/team-viewer'

/**
 * A business reading one of its links (2026-10-08): the page's own script
 * posts here once the page has been visible a moment (`lib/link-view.ts` says
 * why a GET is not a view). Public, under `/api/l` in `proxy.ts`; the token
 * is the credential. Counts a view — and on the first, raises the follow-up
 * task — unless the agent names itself a robot or the reader is signed in to
 * the team that made the link. Answers 204 with no body either way, 404 for a
 * token that names no live link of that kind, never anything enumerable.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NONE = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params
  if (!SHARE_LINK_TOKEN_SHAPE.test(token)) return NONE(404)
  const raw = await request.text().catch(() => '')
  if (raw.length > 200) return NONE(413)
  let kind = null
  try {
    kind = linkKindOf((JSON.parse(raw || '{}') as { kind?: unknown }).kind)
  } catch {
    return NONE(400)
  }
  if (!kind) return NONE(400)
  if (isRobotAgent(request.headers.get('user-agent'))) return NONE(204)
  try {
    const db = getDb() as unknown as AgencyDb
    const now = new Date()
    const link = await shareLinkResolve(db, token, kind, now)
    if (!link) return NONE(404)
    if (await viewerIsTeam(link.orgId)) return NONE(204)
    const [company] = await db
      .select({ name: schema.companies.name, domain: schema.companies.domain })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, link.orgId), eq(schema.companies.id, link.companyId)))
      .limit(1)
    await shareLinkCountView(db, { link, companyName: company?.name || company?.domain || 'The business', now })
    return NONE(204)
  } catch (err) {
    log.warn('a link view could not be recorded', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NONE(500)
  }
}
