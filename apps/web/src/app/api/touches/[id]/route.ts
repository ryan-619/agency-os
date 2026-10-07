import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { editDraft, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * A person changes the words of a message that has not gone yet (2026-10-08).
 *
 * Gated like a decision (`approvals:decide`): whoever may approve the words
 * may change them. `editDraft` does the rest — email and LinkedIn only (a
 * text is a registered template), only a message not yet sent, an approved
 * email back to awaiting approval, and only over the words the editor loaded
 * (`expectedSubject`, `expectedBody`), so two editors cannot overwrite each
 * other unseen.
 *
 * Nothing is sent by this, and nothing about the evidence changes: the send
 * path still judges what the words may quote by when they were first written.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { subject, body, expectedSubject, expectedBody } = (raw ?? {}) as Record<string, unknown>
  if (typeof body !== 'string') return NextResponse.json({ error: 'The message needs some words.' }, { status: 400 })
  if (subject !== undefined && subject !== null && typeof subject !== 'string') {
    return NextResponse.json({ error: 'The subject must be text.' }, { status: 400 })
  }
  const asExpected = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined)
  const expected = { subject: asExpected(expectedSubject), body: asExpected(expectedBody) }
  if (expected.subject === undefined || expected.body === undefined) {
    return NextResponse.json({ error: 'Send the words you started from, so a change made meanwhile is not overwritten.' }, { status: 400 })
  }

  try {
    const r = await editDraft(getDb() as unknown as AgencyDb, {
      orgId: user.orgId,
      touchId: id,
      editedBy: user.id,
      subject: subject as string | null | undefined,
      body,
      expected: { subject: expected.subject, body: expected.body },
    })
    if (!r.ok) {
      const status = r.reason === 'not_found' ? 404 : r.reason === 'invalid' ? 400 : 409
      return NextResponse.json({ error: r.message, reason: r.reason }, { status })
    }
    return NextResponse.json({
      subject: r.touch.subject,
      body: r.touch.body,
      status: r.touch.status,
      changed: r.changed,
      reapprove: r.reapprove,
    })
  } catch (err) {
    // The fault's class only: drizzle's message quotes the bound parameters,
    // which are the words of a message to a named person (§2.3).
    log.error('draft edit failed', { error: err instanceof Error ? err.name : 'UnknownError' })
    return NextResponse.json({ error: 'The edit could not be saved. Nothing changed; try again.' }, { status: 500 })
  }
}
