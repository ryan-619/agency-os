import { NextResponse } from 'next/server'
import { can } from '@agency/core'
import { auth } from '@/auth'
import { agentConfigured, startTurn } from '@/lib/agent'
import { refusalFromUpstream } from '@/lib/agent-refusal'

/**
 * Start an agent turn and stream it to the browser (PROMPT.md §5.2, §8.1).
 *
 * This route does exactly three things: prove who is asking, forward the
 * request to the worker, and hand the worker's stream back untouched.
 *
 * Untouched matters. Re-parsing and re-encoding the events here would put a
 * second place that has to understand the wire format, and would make this
 * process buffer a stream whose entire purpose is not to be buffered. The
 * worker already frames the events; Next is a pipe.
 *
 * The `userId` in the body is a claim the WORKER re-checks against the
 * database — it will not serve a conversation that does not belong to that
 * user. So this is authentication, and the worker does authorisation, and
 * neither trusts the other's word for it.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0
// The Node runtime, not Edge: the Edge runtime's fetch has a different
// streaming contract and this route's whole job is to pass a stream through.
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'chat:use')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (!agentConfigured()) {
    // Not an error. A deployment without an agent worker still has a working
    // CRM, and the panel says the agent is unavailable rather than failing.
    return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { chatSessionId, text } = (body ?? {}) as { chatSessionId?: unknown; text?: unknown }
  if (typeof chatSessionId !== 'string' || !chatSessionId) {
    return NextResponse.json({ error: 'chatSessionId is required' }, { status: 400 })
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }
  if (text.length > 32_000) {
    return NextResponse.json({ error: 'text is too long' }, { status: 413 })
  }

  const upstream = await startTurn({ chatSessionId, userId: user.id, text })
  if (!(upstream instanceof Response)) {
    return NextResponse.json({ error: `agent_${upstream.reason}` }, { status: 503 })
  }

  const res = upstream
  if (!res.ok || !res.body) {
    // The worker refused — chat disabled, no such conversation — and its code
    // goes through. But behind a tunnel what answered may not be the worker
    // at all: ngrok's page for a Mac that is off, a proxy's HTML. Those, and
    // the worker refusing this site's token, are told apart here, because
    // the panel can only word what it is told (review round 15).
    const body = await res.text().catch(() => '')
    const reply = refusalFromUpstream({
      status: res.status,
      contentType: res.headers.get('content-type'),
      ngrokErrorCode: res.headers.get('ngrok-error-code'),
      body,
    })
    return NextResponse.json(reply.body, { status: reply.status })
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
