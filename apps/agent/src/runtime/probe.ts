/**
 * Test connection (PROMPT.md §6).
 *
 * §6: *"A 'Test connection' button that starts a throwaway session, lists the
 * server's tools, writes `last_ok_at` or `last_error`, and shows the tool
 * list."* This is that, and it lives in the worker because the SDK does — the
 * web app never imports it, and CI builds the web app with no secrets to keep
 * it that way.
 *
 * The session really is throwaway. It connects ONE server, asks the SDK what
 * that server exposes, and is torn down: no model call, no prompt, no cost,
 * and nothing written to the conversation. A probe that ran a turn would
 * charge someone money for pressing a button labelled Test.
 *
 * ## Why the tool list matters more than "it connected"
 *
 * A connector's tools each need a human on every call — the risk classifier
 * rates an unreviewed third-party tool `high`, and CLAUDE.md §8 explains why
 * the `mcp__server__*` wildcard is refused. So the list this returns is the
 * only chance anyone gets to see what they are about to let the agent reach,
 * BEFORE enabling it. The UI shows the names; the point is that a server
 * offering `delete_everything` is visible at the moment of the decision.
 *
 * ## What a failure may say
 *
 * The SDK's error text can carry the URL, and a URL can carry a token in a
 * query string despite every instruction not to put one there. §2.3 has no
 * exception for error messages, so the reason is REWRITTEN from a small set
 * rather than passed through.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgencyDb, ConnectorRow } from '@agency/db'
import { recordConnectorProbe } from '@agency/db'
import type { Logger } from '../logger.js'
import { buildConnector } from './connectors.js'
import { childEnv } from './options.js'

export interface ProbeResult {
  readonly ok: boolean
  /** The tools the server exposes. Empty when it did not connect. */
  readonly tools: readonly { readonly name: string; readonly description: string }[]
  /** One sentence for a person, safe to store and to render. */
  readonly message: string
}

/** How long to wait for a server to answer before calling it unreachable. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * How often to re-ask while the server is still connecting.
 *
 * MCP startup is NON-BLOCKING in this SDK: `mcpServerStatus()` answers
 * immediately, and a server that is perfectly healthy reports `pending` for
 * the first second or two. Taking that first answer as the result made Test
 * connection report "could not be reached" for every working server — the
 * worst possible failure for a button whose entire job is to tell you whether
 * a server works.
 *
 * `pending` is "not yet", so this asks again until it becomes something else
 * or the deadline passes. (The `alwaysLoad` flag would make startup blocking
 * instead, but it is capped at a 5s connect timeout and it changes how the
 * server's tools are loaded into a real turn — a probe should not need a
 * different server config from the one it is testing.)
 */
const POLL_MS = 400

/**
 * Turn whatever the SDK said into something safe to show and to store.
 *
 * Matched on shape rather than passed through: an SDK or transport error can
 * carry the URL, and the URL can carry a credential.
 */
function explain(status: string | undefined, raw: string | undefined): string {
  if (status === 'needs-auth') {
    return 'The server answered but rejected the credential. Check the API key in Settings.'
  }
  const text = (raw ?? '').toLowerCase()
  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('getaddrinfo')) {
    return 'That host could not be found. Check the URL.'
  }
  if (text.includes('econnrefused')) return 'Nothing is listening at that address.'
  if (text.includes('certificate') || text.includes('self-signed') || text.includes('altname')) {
    return 'Its TLS certificate was rejected.'
  }
  if (text.includes('401') || text.includes('403') || text.includes('unauthor')) {
    return 'The server rejected the credential. Check the API key in Settings.'
  }
  if (text.includes('404')) return 'That URL answered, but it is not an MCP endpoint.'
  if (text.includes('enoent') || text.includes('spawn')) {
    return 'That command could not be run on the worker. Check the command and its arguments.'
  }
  if (text.includes('timeout') || text.includes('etimedout')) {
    return 'The server did not answer in time.'
  }
  return 'The server could not be reached. Nothing more specific came back.'
}

/**
 * Probe one connector and record the outcome on its row.
 *
 * Never throws: every path ends in a `ProbeResult`, because the caller is a
 * button and a button must always say something.
 */
export async function probeConnector(
  db: AgencyDb,
  row: ConnectorRow,
  masterKey: Buffer | null,
  apiKey: string,
  cwd: string,
  log: Logger,
): Promise<ProbeResult> {
  const record = async (result: ProbeResult): Promise<ProbeResult> => {
    try {
      await recordConnectorProbe(
        db,
        row.orgId,
        row.id,
        result.ok ? { ok: true } : { ok: false, error: result.message },
      )
    } catch (err) {
      // The probe's ANSWER is what the person is waiting for. Failing to write
      // it down is worth a log line and nothing more.
      log.warn('could not record a connector probe', {
        connector: row.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
    }
    return result
  }

  // Built through the same path a turn uses, so a probe that passes means the
  // thing a turn would build is the thing that answered. A separate,
  // probe-only builder is how "Test connection said it was fine" becomes a
  // sentence nobody can explain.
  //
  // `buildConnector` rather than `buildMcpServers`: this row is DISABLED — it
  // is enabled only after somebody has seen it respond — so the enabled-rows
  // query would find nothing to test.
  const built = await buildConnector(db, row, masterKey, log)
  if ('why' in built) {
    // The builder's reasons are written for a person and contain no secrets.
    return record({ ok: false, tools: [], message: built.why })
  }
  const server = built.server

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)

  try {
    const session = query({
      // An empty prompt stream: the session connects its servers and then has
      // nothing to do. No model call, so no cost.
      prompt: (async function* () {
        await new Promise<void>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })(),
      options: {
        // Everything off. This session must not be able to DO anything — it
        // exists to ask one question about one server.
        tools: [],
        allowedTools: [],
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: 'default',
        canUseTool: async () => ({
          behavior: 'deny' as const,
          message: 'A connection test does not run tools.',
        }),
        mcpServers: { [row.name]: server } as never,
        abortController: abort,
        cwd,
        env: childEnv(apiKey),
        maxTurns: 1,
      },
    })

    let statuses
    try {
      // Ask until the server stops saying "pending", or we run out of time.
      for (;;) {
        statuses = await session.mcpServerStatus()
        const current = statuses.find((s) => s.name === row.name)
        if (current?.status !== 'pending') break
        if (abort.signal.aborted) break
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS)
          abort.signal.addEventListener('abort', () => {
            clearTimeout(t)
            resolve()
          }, { once: true })
        })
      }
    } finally {
      // Tear the session down whatever happened. A leaked subprocess per
      // button press is a slow leak that only shows up in production.
      try {
        await session.interrupt()
      } catch {
        // Already gone. Nothing to do.
      }
    }

    const status = statuses.find((s) => s.name === row.name)
    if (!status) {
      return record({
        ok: false,
        tools: [],
        message: 'The agent runtime did not report on this server. Try again.',
      })
    }
    if (status.status !== 'connected') {
      // Logged, because a failed probe is the thing an operator gets asked
      // about. The STATUS is safe to log; `status.error` is not — it can carry
      // the URL, and the URL can carry a credential someone pasted into the
      // wrong field (§2.3).
      log.info('connector probe did not connect', { connector: row.name, status: status.status })
      return record({
        ok: false,
        tools: [],
        message:
          status.status === 'pending'
            ? 'The server did not finish connecting in time.'
            : explain(status.status, status.error),
      })
    }

    const tools = (status.tools ?? []).map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 300),
    }))
    log.info('connector probe succeeded', { connector: row.name, tools: tools.length })
    return record({
      ok: true,
      tools,
      message:
        tools.length === 0
          ? 'Connected, but the server offers no tools. Enabling it would add nothing.'
          : `Connected. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
    })
  } catch (err) {
    log.warn('connector probe failed', {
      connector: row.name,
      error: err instanceof Error ? err.name : 'UnknownError',
    })
    return record({
      ok: false,
      tools: [],
      message: abort.signal.aborted
        ? 'The server did not answer within 20 seconds.'
        : explain(undefined, err instanceof Error ? err.message : ''),
    })
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
