import { redirect } from 'next/navigation'
import { createChatSession, listChatSessions, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { askDraftFrom } from '@/lib/ask-link'

/**
 * The chat link in the sidebar (PROMPT.md §8.1): your newest thread, or a new
 * one if you have none.
 *
 * It renders nothing itself. It picks the thread and redirects to
 * `/chat/<id>`, so the address bar always names the conversation on screen —
 * a reload stays on it, and a link to it is a link to it — and the one page
 * that renders a thread is the one that checks it is yours.
 *
 * The thread is created server-side before anything is typed, so the turn
 * route always has a conversation to address and the worker never invents
 * one. An archived thread is not "newest": archiving everything and coming
 * back here starts a fresh thread rather than reopening one you put away.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ ask?: string | string[] }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const existing = await listChatSessions(db, user.orgId, user.id, 1)
  const thread = existing[0] ?? (await createChatSession(db, { orgId: user.orgId, userId: user.id }))
  // "Ask the assistant about this" (2026-10-09): the words a record page sent along ride to the thread.
  const ask = askDraftFrom((await searchParams).ask)
  redirect(ask ? `/chat/${thread.id}?ask=${encodeURIComponent(ask)}` : `/chat/${thread.id}`)
}
