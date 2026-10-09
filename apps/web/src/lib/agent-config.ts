/**
 * Whether this web half can reach a chat worker: the one reading of
 * `AGENT_URL` and `AGENT_INTERNAL_TOKEN`, shared by `lib/agent.ts` (which
 * calls the worker) and `flagsFrom` (which says what is configured).
 *
 * The two are validated HERE and not in `env()`'s schema. `env()` parses every
 * variable at once and throws on any failure, so a malformed value for this
 * one optional feature — an `AGENT_URL` pasted without its `https://`, a token
 * cut short — made every page answer 500, and with them the one-click
 * unsubscribe and every inbound webhook, a STOP included (production,
 * 2026-10-02; review round 15). A malformed value now turns CHAT off and says
 * which variable, by name and never by value.
 *
 * Pure, and imports nothing: a test reads it directly.
 */

export type AgentVariable = 'AGENT_URL' | 'AGENT_INTERNAL_TOKEN'

export type AgentConfig =
  | { readonly state: 'configured'; readonly url: string; readonly token: string }
  | { readonly state: 'not_configured' }
  | { readonly state: 'misconfigured'; readonly variables: readonly AgentVariable[] }

/** The shortest token the worker is worth guarding with; the worker's own schema asks the same. */
export const AGENT_TOKEN_MIN_LENGTH = 32

/** A trimmed value, or undefined for a missing or blank one. */
function present(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

/** An absolute http(s) address, with any trailing slash dropped, or null. */
function workerUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.hostname === '' || u.username !== '' || u.password !== '') return null
  // The calls append `/internal/…`, so `https://x.example/` must not become
  // `https://x.example//internal/…`.
  return raw.replace(/\/+$/, '')
}

export function agentConfigFrom(e: {
  readonly AGENT_URL?: string | undefined
  readonly AGENT_INTERNAL_TOKEN?: string | undefined
}): AgentConfig {
  const rawUrl = present(e.AGENT_URL)
  const token = present(e.AGENT_INTERNAL_TOKEN)
  const url = rawUrl === undefined ? undefined : workerUrl(rawUrl)

  const bad: AgentVariable[] = []
  if (rawUrl !== undefined && url === null) bad.push('AGENT_URL')
  if (token !== undefined && token.length < AGENT_TOKEN_MIN_LENGTH) bad.push('AGENT_INTERNAL_TOKEN')
  if (bad.length > 0) return { state: 'misconfigured', variables: bad }

  if (url === undefined || url === null || token === undefined) return { state: 'not_configured' }
  return { state: 'configured', url, token }
}

const WHAT_IS_WRONG: Record<AgentVariable, string> = {
  AGENT_URL: 'AGENT_URL is set here but is not a full http(s) address — it must start with https://, for example https://your-name.ngrok-free.app',
  AGENT_INTERNAL_TOKEN: `AGENT_INTERNAL_TOKEN is set here but is shorter than ${AGENT_TOKEN_MIN_LENGTH} characters — it must be the whole token the worker was started with`,
}

/**
 * What a person reads when chat is off because of a value, not an absence:
 * which variable, what it must look like, and that nothing else is affected.
 * Never the value, which for the token is a credential (§2.3).
 */
export function agentMisconfiguredSentence(variables: readonly AgentVariable[]): string {
  const parts = variables.map((v) => WHAT_IS_WRONG[v])
  return (
    `${parts.join('; and ')}. So chat is off. Correct it in this deployment’s environment variables ` +
    'and redeploy; everything else here works without it.'
  )
}
