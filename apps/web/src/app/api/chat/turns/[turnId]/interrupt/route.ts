import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { runningTurnOwner } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { agentConfigured, interruptTurn } from '@/lib/agent'

/**
 * Stop a running turn (PROMPT.md §8.1).
 *
 * The Stop button used to call `AbortController.abort()` and nothing else,
 * which closed the browser's end of the stream and left the turn running. The
 * agent kept calling tools, kept spending against the session budget, and kept
 * the conversation claim — so the next message was refused as "already
 * running" while the panel showed a finished, idle chat. A Stop that stops
 * nothing is worse than no Stop at all, because it is the control a person
 * reaches for when the agent is doing something they do not want.
 *
 * The worker's `/internal/turns/:id/interrupt` takes a turn id and looks it up
 * in an in-process map — it does no ownership check, because by the time a
 * request reaches it the web app has established who is asking. This is that
 * check. A turn id is the only handle the browser has, so without it the id
 * alone would be enough to stop a turn in another org.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'chat:use')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!agentConfigured()) {
    return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  }

  const { turnId } = await params
  if (!/^[0-9a-fA-F-]{36}$/.test(turnId)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const owner = await runningTurnOwner(getDb(), turnId)

  // Already finished. Not an error: a Stop pressed a moment too late got the
  // outcome the person wanted, and saying so would put a red notice under a
  // chat that is behaving correctly.
  if (!owner) return NextResponse.json({ interrupted: false, reason: 'already_finished' })

  // Another org, or another person's conversation. Answered identically to a
  // turn that does not exist, so this is not a way to learn that one does.
  if (owner.orgId !== user.orgId || owner.userId !== user.id) {
    return NextResponse.json({ interrupted: false, reason: 'already_finished' })
  }

  const interrupted = await interruptTurn(turnId)

  // The worker is unreachable, so the turn was NOT stopped. Said plainly
  // rather than reported as a success — the alternative is a person believing
  // they stopped an agent that is still working.
  if (!interrupted) {
    return NextResponse.json({ error: 'agent_unreachable' }, { status: 503 })
  }
  return NextResponse.json({ interrupted: true })
}
