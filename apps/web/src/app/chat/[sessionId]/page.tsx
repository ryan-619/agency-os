import { notFound, redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import {
  approvalsForSession, chatMessages, chatReadOwnSession, chatSessionCosts, listChatSessions, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ChatPanel } from '@/components/chat/panel'
import { ChatThreads, type ThreadView } from '@/components/chat/threads'
import { blocksFromTranscript } from '@/components/chat/reducer'
import { getDb } from '@/lib/db'
import { agentConfigured } from '@/lib/agent'
import { icpForOrg } from '@/lib/queries'

/**
 * One chat thread, and the list of the others (PROMPT.md §8.1).
 *
 * Only the person who owns the thread sees it. A thread is somebody's own
 * prompts (§2.3) — what they asked about which company, what they were
 * thinking of sending — and a teammate in the same org has no more business
 * reading it than a stranger does. `chatReadOwnSession` puts the user in the
 * WHERE, so a thread that is not yours is a 404 whether it belongs to a
 * colleague, another org, or nobody: the page cannot tell them apart, and so
 * neither can anyone probing it.
 *
 * Everything on this page works with no worker. The list, the transcript, a
 * new thread, a rename and an archive are rows; only STARTING a turn needs
 * the agent, and the panel says so where the composer would be.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function ChatThreadPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const { sessionId } = await params

  const db = getDb() as unknown as AgencyDb
  const thread = await chatReadOwnSession(db, user.orgId, user.id, sessionId)
  if (!thread) notFound()

  // What was said last time. Rebuilt on the server so the panel is never blank
  // while the worker resumes a conversation the model still remembers in full.
  const [rows, approvals, listed, costs, icpRow] = await Promise.all([
    chatMessages(db, user.orgId, thread.id),
    approvalsForSession(db, user.orgId, thread.id),
    listChatSessions(db, user.orgId, user.id),
    chatSessionCosts(db, user.orgId, user.id),
    icpForOrg(user.orgId),
  ])
  const initialBlocks = blocksFromTranscript(
    rows.map((r) => ({
      id: r.id, role: r.role, content: r.content, toolName: r.toolName,
      toolUseId: r.toolUseId, turnId: r.turnId,
    })),
    approvals.map((a) => ({
      id: a.id, toolName: a.toolName, payload: a.payload, risk: a.risk, status: a.status,
      expiresAt: a.expiresAt.toISOString(), toolUseId: a.toolUseId, decidedReason: a.decidedReason,
    })),
  )

  // The list is the fifty most recently active. A thread opened from an old
  // link can be older than all of them, and the list is where its Rename and
  // Archive live — so an open, unarchived thread is always in it.
  const shown = thread.archived || listed.some((s) => s.id === thread.id) ? listed : [...listed, thread]

  // Plain values only: this crosses into a client component, and a Date or a
  // Map does not survive the trip as one.
  const threads: ThreadView[] = shown.map((s) => ({
    id: s.id,
    title: s.title,
    lastActiveAt: s.lastActiveAt.toISOString(),
    running: s.runningTurnId !== null,
    costUsd: costs.get(s.id) ?? null,
  }))

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

  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  return (
    <Shell user={user} orgName={orgLabel} current="chat" signOut={signOutAction}>
      <h1>Chat</h1>
      <p className="lede">
        The agent reads the CRM and can scan a company&apos;s public pages. It cannot send
        anything: a draft goes to the approval queue and waits for a person.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 220px', minWidth: 0 }}>
          <ChatThreads
            threads={threads}
            current={{ id: thread.id, title: thread.title, archived: thread.archived }}
            canUse={can(principal, 'chat:use')}
          />
        </div>
        <div style={{ flex: '1 1 460px', minWidth: 0 }}>
          {/* Keyed by thread: the panel keeps its conversation in state, and
              switching threads without a remount would show the last one's. */}
          <ChatPanel
            key={thread.id}
            sessionId={thread.id}
            agentAvailable={agentConfigured()}
            archived={thread.archived}
            canDecide={can(principal, 'approvals:decide')}
            initialBlocks={initialBlocks}
          />
        </div>
      </div>
    </Shell>
  )
}
