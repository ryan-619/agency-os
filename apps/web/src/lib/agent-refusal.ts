/**
 * What a refused chat turn says, read from the answer that came back from
 * AGENT_URL — which, on the documented laptop shape, is ngrok's edge rather
 * than the worker (review round 15). Behind a tunnel `fetch` never throws:
 * a Mac that is off or asleep, a worker that is down, and a worker that
 * refuses this site's token all come back as an ordinary HTTP answer, and
 * the route passed each through as the worker's own words, so the panel said
 * "The agent could not start" for all three.
 *
 * Only the worker answers in the worker's shape: JSON carrying an `error`
 * code. Anything else — ngrok's offline page (it marks every error it
 * writes with an `ngrok-error-code` header), a proxy's HTML, an empty body —
 * did not come from a running worker, so it is `agent_unreachable`. The
 * worker's 401 is `agent_token_refused`: AGENT_INTERNAL_TOKEN here is not
 * the one the worker was started with.
 *
 * Pure, and imports nothing: a test reads it directly.
 */

export interface UpstreamAnswer {
  readonly status: number
  readonly contentType: string | null
  /** ngrok's own marker on an error it wrote itself (e.g. ERR_NGROK_3200, the endpoint is offline). */
  readonly ngrokErrorCode: string | null
  readonly body: string
}

export interface RefusalReply {
  readonly status: number
  readonly body: { readonly error: string }
}

/** The worker's own refusal code, when the answer is one. */
function workerCode(a: UpstreamAnswer): string | null {
  if (!a.contentType || !/^application\/json\b/i.test(a.contentType.trim())) return null
  try {
    const parsed: unknown = JSON.parse(a.body)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      const code = (parsed as { error: string }).error
      return code.length > 0 && code.length <= 80 ? code : null
    }
  } catch {
    // not the worker's JSON
  }
  return null
}

export function refusalFromUpstream(a: UpstreamAnswer): RefusalReply {
  if (a.ngrokErrorCode) return { status: 503, body: { error: 'agent_unreachable' } }
  const code = workerCode(a)
  if (code === null) return { status: 503, body: { error: 'agent_unreachable' } }
  if (a.status === 401 && code === 'unauthorized') return { status: 503, body: { error: 'agent_token_refused' } }
  return { status: a.status >= 400 && a.status <= 599 ? a.status : 502, body: { error: code } }
}
