import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { TASK_DETAIL_MAX, tasksCreate, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Create a to-do: a reminder to a person, with an owner and a due date.
 *
 * Only `todo` is created here. A LinkedIn step is materialised from an
 * approved message, and the kickoff and renewal sets come from their
 * template route — so a person cannot type a task that pretends to be
 * either. Nothing is sent, and the response says so.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const optionalId = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || (typeof v === 'string' && UUID.test(v))

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
  const b = (body ?? {}) as {
    title?: unknown; detail?: unknown; companyId?: unknown; dealId?: unknown; assigneeUserId?: unknown; dueAt?: unknown
    kind?: unknown
  }
  // A person may make a to-do, a call or a visit (0022). The other kinds are
  // made by the system — a LinkedIn step, a kickoff or renewal set — never by hand.
  const kind = b.kind === undefined || b.kind === null ? 'todo' : b.kind
  if (kind !== 'todo' && kind !== 'call' && kind !== 'visit') {
    return NextResponse.json({ error: 'A task made by hand is a to-do, a call or a visit.' }, { status: 400 })
  }
  if (typeof b.title !== 'string') return NextResponse.json({ error: 'A task needs a title.' }, { status: 400 })
  if (b.detail !== undefined && b.detail !== null && typeof b.detail !== 'string') {
    return NextResponse.json({ error: 'detail must be text' }, { status: 400 })
  }
  for (const key of ['companyId', 'dealId', 'assigneeUserId'] as const) {
    if (!optionalId(b[key])) return NextResponse.json({ error: `${key} must be an id` }, { status: 400 })
  }
  if (b.dueAt !== undefined && b.dueAt !== null && (typeof b.dueAt !== 'string' || Number.isNaN(Date.parse(b.dueAt)))) {
    return NextResponse.json({ error: 'dueAt must be an ISO-8601 time' }, { status: 400 })
  }

  const r = await tasksCreate(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    kind,
    title: b.title.slice(0, 1000),
    detail: typeof b.detail === 'string' ? b.detail.slice(0, TASK_DETAIL_MAX) : null,
    companyId: (b.companyId as string | null | undefined) ?? null,
    dealId: (b.dealId as string | null | undefined) ?? null,
    assigneeUserId: (b.assigneeUserId as string | null | undefined) ?? null,
    dueAt: typeof b.dueAt === 'string' ? new Date(b.dueAt) : null,
    createdBy: user.id,
    actor: user.id,
  })
  if (!r.ok) {
    const status = r.reason === 'not_found' ? 404 : r.reason === 'duplicate_open_for_touch' || r.reason === 'suppressed' ? 409 : 400
    return NextResponse.json({ error: r.message }, { status })
  }
  return NextResponse.json(
    { id: r.task.id, note: 'Saved. Nothing was sent — a task is a reminder to a person.' },
    { status: 201 },
  )
}
