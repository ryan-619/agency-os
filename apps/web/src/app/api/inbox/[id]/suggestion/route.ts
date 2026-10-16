import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertCan } from '@agency/core'
import { replySuggestionDismiss, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Put a suggested answer away (0026). The one thing a person does to a
 * suggestion besides starting the composer from it, which is the reply
 * route's. Dismissing writes `dismissed_at` and an audit row; the words
 * stay on the row, and the inbox stops showing them. `campaigns:write`,
 * like answering, because the suggestion exists for whoever may answer.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const bodySchema = z.object({ action: z.literal('dismiss') })

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'campaigns:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'That reply is not in this inbox.' }, { status: 404 })
  const raw = await request.text()
  if (raw.length > 1024) return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!bodySchema.safeParse(body).success) return NextResponse.json({ error: 'That request could not be read.' }, { status: 400 })

  const db = getDb() as unknown as AgencyDb
  const r = await replySuggestionDismiss(db, { orgId: user.orgId, touchId: id, actor: user.id })
  if (!r.ok) {
    return r.reason === 'already'
      ? NextResponse.json({ error: 'That suggestion was already put away.' }, { status: 409 })
      : NextResponse.json({ error: 'There is no suggested answer on that reply.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
