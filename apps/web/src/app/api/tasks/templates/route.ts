import { NextResponse } from 'next/server'
import { assertCan, isTaskTemplateName } from '@agency/core'
import { tasksApplyTemplate, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Apply the kickoff or renewal template to a company — because a person
 * pressed the button, and for no other reason. A deal reaching `won` creates
 * nothing on its own; a board that fills itself with work nobody asked for
 * is a board people stop reading.
 *
 * Both sets hang off a won deal, and a set still open is not applied twice.
 * The tasks are assigned to whoever pressed the button, who can hand them
 * on. Nothing is sent: the kickoff items that involve the client are things
 * a person arranges from their own mailbox. `tasksApplyTemplate` writes the
 * `task.template_applied` audit row with the template, company and count.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as { template?: unknown; companyId?: unknown; dealId?: unknown }
  if (!isTaskTemplateName(b.template)) {
    return NextResponse.json({ error: 'template must be kickoff or renewal' }, { status: 400 })
  }
  if (typeof b.companyId !== 'string' || !UUID.test(b.companyId)) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  if (b.dealId !== undefined && b.dealId !== null && (typeof b.dealId !== 'string' || !UUID.test(b.dealId))) {
    return NextResponse.json({ error: 'dealId must be an id' }, { status: 400 })
  }

  const r = await tasksApplyTemplate(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    template: b.template,
    companyId: b.companyId,
    dealId: typeof b.dealId === 'string' ? b.dealId : null,
    assigneeUserId: user.id,
    createdBy: user.id,
    actor: user.id,
  })
  if (!r.ok) {
    const status = r.reason === 'not_found' ? 404 : r.reason === 'assignee_not_in_org' ? 400 : 409
    return NextResponse.json({ error: r.message }, { status })
  }
  return NextResponse.json(
    {
      template: b.template,
      count: r.tasks.length,
      note: `Created ${r.tasks.length} ${b.template} tasks, assigned to you. Nothing was sent.`,
    },
    { status: 201 },
  )
}
