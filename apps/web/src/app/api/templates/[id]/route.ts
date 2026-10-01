import { NextResponse } from 'next/server'
import { templatesSetActive, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { TEMPLATE_MAX_REQUEST_BYTES, firstIssue, mayWriteTemplates, templatePatchSchema, templateView } from '../rules'

/**
 * Switch one template on or off (0019) — the only change a recorded template
 * takes. Its words are never edited: the portal issues a new id when a body
 * changes, and a sent message names the words it was checked against.
 *
 * Off is how a template stops being used: nothing new is drafted from it,
 * and a draft already written from it is refused `no_template` at sending.
 * Idempotent — asking for the state it is already in changes nothing and
 * writes no audit row. Another org's template, or a made-up id, is a 404.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteTemplates({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such template.' }, { status: 404 })

  const raw = await request.text()
  if (raw.length > TEMPLATE_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = templatePatchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const r = await templatesSetActive(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    templateId: id,
    active: parsed.data.active,
    actor: user.id,
  })
  if (!r.ok) return NextResponse.json({ error: 'No such template.' }, { status: 404 })
  return NextResponse.json({ template: templateView(r.template), changed: r.changed })
}
