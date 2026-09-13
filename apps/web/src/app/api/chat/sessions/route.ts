import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { createChatSession, listChatSessions, type AgencyDb, type ChatSessionRow } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Chat threads (PROMPT.md §5.3, §8.1).
 *
 * A thread is created before anything is said in it, so the turn route always
 * has a conversation to address and the worker never has to invent one. That
 * also means `chat_sessions` can hold an empty thread — a person who opened
 * the panel and typed nothing — which the list quietly shows with its
 * timestamp until the first message gives it a title.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const rows = await listChatSessions(getDb() as unknown as AgencyDb, user.orgId, user.id)
  return NextResponse.json({
    sessions: rows.map((s: ChatSessionRow) => ({
      id: s.id,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
      // A thread with a turn in flight, so a reopened tab can show it is busy
      // rather than offering an input box that will be refused.
      running: s.runningTurnId !== null,
    })),
  })
}

export async function POST(): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'chat:use')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const created = await createChatSession(getDb() as unknown as AgencyDb, {
    orgId: user.orgId,
    userId: user.id,
  })
  return NextResponse.json({ id: created.id }, { status: 201 })
}
