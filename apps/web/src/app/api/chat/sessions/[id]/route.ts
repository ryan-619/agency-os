import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import {
  CHAT_TITLE_MAX, chatArchiveSession, chatRenameSession, chatRestoreSession, type AgencyDb,
} from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Rename, archive or restore one of your own threads (PROMPT.md §8.1).
 *
 * No worker is involved: a thread is a row, and every change here is to the
 * row. The owner check is not made here — each query puts the org AND the
 * user in its WHERE, so a teammate's thread id answers 404 exactly as a
 * made-up one does, and nothing about another person's conversation can be
 * learned by trying ids.
 *
 * One change per request. A body carrying a title and an archive could have
 * the rename written and the archive refused, which is a rejected request
 * that changed the database.
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
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'chat:use')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { title, archived } = (body ?? {}) as { title?: unknown; archived?: unknown }

  if ((title === undefined) === (archived === undefined)) {
    return NextResponse.json({ error: 'Send either a title or archived, one change at a time.' }, { status: 400 })
  }

  const db = getDb() as unknown as AgencyDb
  const who = { orgId: user.orgId, userId: user.id, id }

  if (title !== undefined) {
    if (typeof title !== 'string') {
      return NextResponse.json({ error: `title must be text of at most ${CHAT_TITLE_MAX} characters` }, { status: 400 })
    }
    const result = await chatRenameSession(db, { ...who, title })
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.reason === 'not_found' ? 404 : 400 })
    }
    return NextResponse.json({ id, title: result.title })
  }

  if (typeof archived !== 'boolean') {
    return NextResponse.json({ error: 'archived must be true or false' }, { status: 400 })
  }

  if (!archived) {
    if (!(await chatRestoreSession(db, who))) return NextResponse.json({ error: 'No such thread.' }, { status: 404 })
    return NextResponse.json({ id, archived: false })
  }

  const result = await chatArchiveSession(db, who)
  if (!result.ok) {
    if (result.reason === 'not_found') return NextResponse.json({ error: 'No such thread.' }, { status: 404 })
    // A running turn may be parked on an approval in this thread; archiving
    // it now would hide the card somebody has to decide on.
    return NextResponse.json(
      {
        error:
          'The agent is still working in this thread, and may be waiting on an approval here. ' +
          'Archive it once that turn has finished.',
      },
      { status: 409 },
    )
  }
  return NextResponse.json({ id, archived: true })
}
