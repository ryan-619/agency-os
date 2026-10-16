import 'server-only'
import { env } from '@/lib/env'
import { agentConfigFrom, type AgentConfig } from '@/lib/agent-config'

/**
 * The web app's side of the worker boundary (PROMPT.md §3).
 *
 * Everything the browser does goes through Next, which is where authentication
 * lives; nothing here is reachable without a session. The worker itself binds
 * to loopback and is not exposed.
 *
 * This module exists mostly to be the ONE place that knows the worker's
 * address and token, so a route handler cannot accidentally build the call
 * itself and forget the header. It also deliberately imports nothing from
 * `@anthropic-ai/claude-agent-sdk`: the SDK and the API key stay in the worker
 * process, and CI builds this app with no secrets to keep it that way.
 */

export type AgentUnavailable = {
  readonly ok: false
  readonly reason: 'not_configured' | 'misconfigured' | 'unreachable'
}

/** The worker's address and token as validated by `agentConfigFrom` — never read raw. */
export function agentConfig(): AgentConfig {
  return agentConfigFrom(env())
}

export function agentConfigured(): boolean {
  return agentConfig().state === 'configured'
}

/**
 * Start a turn and hand back the worker's stream, untouched.
 *
 * The response body is passed straight through to the browser rather than
 * parsed and re-encoded. Re-framing it here would mean this process buffering
 * a stream whose whole purpose is not to be buffered, and would put a second
 * place where the event format has to be understood.
 */
export async function startTurn(body: {
  chatSessionId: string
  userId: string
  text: string
  /** "Think harder": the worker runs this one turn on its stronger model. */
  deep: boolean
}): Promise<Response | AgentUnavailable> {
  const c = agentConfig()
  if (c.state !== 'configured') return { ok: false, reason: c.state }

  try {
    return await fetch(`${c.url}/internal/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(body),
      // Node's fetch buffers a response body by default when duplex is not
      // set on a streaming consumer; passing the body through as a stream is
      // the whole point of this route.
      cache: 'no-store',
    })
  } catch {
    // The worker being down is an ordinary operational state, not a crash:
    // the CRM still works and the chat panel says the agent is unavailable.
    return { ok: false, reason: 'unreachable' }
  }
}

export async function interruptTurn(turnId: string): Promise<boolean> {
  const c = agentConfig()
  if (c.state !== 'configured') return false
  try {
    const res = await fetch(`${c.url}/internal/turns/${encodeURIComponent(turnId)}/interrupt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}` },
      cache: 'no-store',
    })
    return res.ok
  } catch {
    return false
  }
}

export interface ProbeAnswer {
  readonly ok: boolean
  readonly tools: readonly { readonly name: string; readonly description: string }[]
  readonly message: string
}

/**
 * Ask the worker to test one connector (§6).
 *
 * Returns null only when the worker itself could not be reached — which is a
 * different fact from "the connector could not be reached", and the two must
 * not be shown as the same thing. A person told their connector is broken,
 * when actually the agent worker is down, will spend an afternoon on the
 * wrong problem.
 */
export async function probeConnector(orgId: string, connectorId: string): Promise<ProbeAnswer | null> {
  const c = agentConfig()
  if (c.state !== 'configured') return null
  try {
    const res = await fetch(
      `${c.url}/internal/connectors/${encodeURIComponent(connectorId)}/probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${c.token}`,
        },
        body: JSON.stringify({ orgId }),
        cache: 'no-store',
      },
    )
    if (!res.ok) return null
    return (await res.json()) as ProbeAnswer
  } catch {
    return null
  }
}
