import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { assertCan } from '@agency/core'
import {
  schema, tasksAssign, tasksComplete, tasksReopen, tasksSetDue, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Change one task: mark it done, reopen it, hand it to somebody, or move its
 * due date. One action per request, so an audit row always says exactly what
 * a person did.
 *
 * A LinkedIn step is not completed from here. It is done when a person has
 * sent the message and pressed "I sent it", which runs every send rule at
 * that moment; ticking the task instead would say the message went when
 * nothing checked that it could. Assigning one and moving its date are fine.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIONS = ['done', 'reopen', 'assign', 'due'] as const
type Action = (typeof ACTIONS)[number]

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such task.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const b = (body ?? {}) as { action?: unknown; assigneeUserId?: unknown; dueAt?: unknown }
  if (typeof b.action !== 'string' || !(ACTIONS as readonly string[]).includes(b.action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 })
  }
  const action = b.action as Action
  // Validated before anything is read or written, like every other route.
  if (action === 'assign' && b.assigneeUserId !== null && (typeof b.assigneeUserId !== 'string' || !UUID.test(b.assigneeUserId))) {
    return NextResponse.json({ error: 'assigneeUserId must be a user id, or null to unassign' }, { status: 400 })
  }
  if (action === 'due' && b.dueAt !== null && (typeof b.dueAt !== 'string' || Number.isNaN(Date.parse(b.dueAt)))) {
    return NextResponse.json({ error: 'dueAt must be an ISO-8601 time, or null to clear it' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const [current] = await db
    .select({ id: schema.tasks.id, kind: schema.tasks.kind })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, user.orgId), eq(schema.tasks.id, id)))
    .limit(1)
  if (!current) return NextResponse.json({ error: 'No such task.' }, { status: 404 })
  if (current.kind === 'linkedin_send' && (action === 'done' || action === 'reopen')) {
    return NextResponse.json(
      { error: 'A LinkedIn step is completed by sending the message and pressing "I sent it", which checks every send rule first.' },
      { status: 409 },
    )
  }

  const common = { orgId: user.orgId, id, actor: user.id }
  switch (action) {
    case 'done': {
      const r = await tasksComplete(db, { ...common, byUserId: user.id })
      if (!r.ok) return NextResponse.json({ error: r.message }, { status: 404 })
      return NextResponse.json({ id, done: true, alreadyDone: r.alreadyDone })
    }
    case 'reopen': {
      const r = await tasksReopen(db, common)
      if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 409 })
      return NextResponse.json({ id, done: false, alreadyOpen: r.alreadyOpen })
    }
    case 'assign': {
      const r = await tasksAssign(db, { ...common, assigneeUserId: b.assigneeUserId as string | null })
      if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 400 })
      return NextResponse.json({ id, assigneeUserId: r.task.assigneeUserId })
    }
    case 'due': {
      const r = await tasksSetDue(db, { ...common, dueAt: typeof b.dueAt === 'string' ? new Date(b.dueAt) : null })
      if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.reason === 'not_found' ? 404 : 400 })
      return NextResponse.json({ id, dueAt: r.task.dueAt ? r.task.dueAt.toISOString() : null })
    }
  }
}
