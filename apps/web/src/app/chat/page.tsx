import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { createChatSession, listChatSessions, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ChatPanel } from '@/components/chat/panel'
import { getDb } from '@/lib/db'
import { agentConfigured } from '@/lib/agent'
import { icpForOrg } from '@/lib/queries'

/**
 * The chat screen (PROMPT.md §8.1).
 *
 * §8.1 asks for a panel "present on every screen". This is the first half of
 * that: a full page where the conversation has room, reached from the sidebar.
 * Docking the same panel into every other page is a layout change across five
 * screens, and doing it before the panel has been used once would be designing
 * in the dark — so it is deliberately not done yet, and the sidebar link is
 * real rather than a phase tag.
 *
 * The thread is created server-side before anything is typed, so the turn
 * route always has a conversation to address and the worker never invents one.
 */
export const dynamic = 'force-dynamic'

export default async function ChatPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const existing = await listChatSessions(db, user.orgId, user.id, 1)
  const thread = existing[0] ?? (await createChatSession(db, { orgId: user.orgId, userId: user.id }))

  const icpRow = await icpForOrg(user.orgId)
  let orgLabel = 'Agency'
  if (icpRow) {
    try {
      orgLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      orgLabel = 'Agency'
    }
  }

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="chat" signOut={signOutAction}>
      <h1>Chat</h1>
      <p className="lede">
        The agent reads the CRM and can scan a company&apos;s public pages. It cannot send
        anything: a draft goes to the approval queue and waits for a person.
      </p>
      <ChatPanel
        sessionId={thread.id}
        agentAvailable={agentConfigured()}
        canDecide={can({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')}
      />
    </Shell>
  )
}
