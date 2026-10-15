/**
 * A connector that refuses, noticed in the turn it refuses (2026-10-13).
 *
 * Read from the worker's own CLI transcripts: firecrawl answered every call
 * "keyless access is unavailable", jina "401 Unauthorized" and tavily "429 …
 * excessive requests", and the model kept calling them — and the in-band
 * shapes (jina's `Error: Search failed … Unauthorized`, tavily's
 * `{"error":…,"status":429}`) came back as SUCCESSES, so nothing in the
 * worker knew. Now the gate's PostToolUse and PostToolUseFailure hooks read
 * each connector result with `connectorResultFailure` (packages/core), and a
 * refusal does three things:
 *
 *  - the model is told, in the same turn and in OUR words — never the
 *    server's, which is somebody else's text and may carry a signup link or
 *    the agent's own search query (`connectorRefusalSentence`);
 *  - the server is marked refused for the rest of THIS turn, and `canUseTool`
 *    denies every later call to it at once with the same sentence;
 *  - the connector row records it (`connectorsRecordFailure`), once per
 *    server per turn, so the next turn's prompt and Settings → Connectors can
 *    say it — and a later clean answer from the server clears it
 *    (`connectorsClearFailure`), at most once per server per turn.
 *
 * The writes never hold a hook up: they run behind the hook's answer, one
 * after another in the order they were asked for, and a write that fails is
 * logged by its error class only.
 */
import type { ConnectorFailureKind } from '@agency/core'

/** The server a tool belongs to — `exa` for `mcp__exa__web_search_exa` — or null for the agency's own or a built-in. */
export function connectorServerOf(toolName: unknown): string | null {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0) return null
  const server = rest.slice(0, cut)
  return server === 'agency' ? null : server
}

/** Our own words for each kind. The server's are never repeated. */
const KIND_WORDS: Readonly<Record<ConnectorFailureKind, string>> = {
  auth: 'its key is missing, wrong or not accepted',
  quota: 'it is rate-limited or out of quota',
}

/**
 * What the model is told about a connector that refused: by the hook when it
 * happens, and by `canUseTool` for every later call to it in the turn. The
 * server's name is the connector row's own, never its text.
 */
export function connectorRefusalSentence(server: string, kind: ConnectorFailureKind): string {
  return (
    `${server} refused that call — ${KIND_WORDS[kind]}. It will refuse again this turn: do not call it again; ` +
    'tell the person it needs attention in Settings → Connectors, and use read_page or another connector instead.'
  )
}

export interface ConnectorWatch {
  /** Why this server refused earlier in this turn, or null. */
  refused(server: string): ConnectorFailureKind | null
  /** The server refused a call: marked for the turn, recorded on its row the first time. */
  fail(server: string, kind: ConnectorFailureKind): void
  /** The server answered a call: its row's refusal cleared, once, unless it refused this turn. */
  ok(server: string): void
}

export interface ConnectorWatchDeps {
  /** `connectorsRecordFailure` for this turn's org. */
  readonly record: (server: string, kind: ConnectorFailureKind) => Promise<unknown>
  /** `connectorsClearFailure` for this turn's org. */
  readonly clear: (server: string) => Promise<unknown>
  readonly log: { warn: (msg: string, fields?: Record<string, unknown>) => void }
}

/** One turn's watch. Built per turn in session.ts and shared by both hooks and `canUseTool`. */
export function createConnectorWatch(deps: ConnectorWatchDeps): ConnectorWatch {
  const refusedThisTurn = new Map<string, ConnectorFailureKind>()
  const cleared = new Set<string>()
  // One write after another: a clear asked for before a refusal must not land after it.
  let writes: Promise<void> = Promise.resolve()
  const write = (what: string, run: () => Promise<unknown>): void => {
    writes = writes
      .then(run)
      .then(
        () => undefined,
        (err: unknown) => {
          try {
            deps.log.warn(what, { error: err instanceof Error ? err.name : 'UnknownError' })
          } catch {
            // A logger that throws must not reach a hook.
          }
        },
      )
  }

  return {
    refused: (server) => refusedThisTurn.get(server) ?? null,
    fail: (server, kind) => {
      if (refusedThisTurn.has(server)) return
      refusedThisTurn.set(server, kind)
      write('could not record a connector’s refusal on its row', () => deps.record(server, kind))
    },
    ok: (server) => {
      if (refusedThisTurn.has(server) || cleared.has(server)) return
      cleared.add(server)
      write('could not clear a connector’s recorded refusal', () => deps.clear(server))
    },
  }
}
