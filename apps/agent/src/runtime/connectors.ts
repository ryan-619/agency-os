/**
 * Turning connector rows into the SDK's `mcpServers` (PROMPT.md §6).
 *
 * This is the file §6 calls "the requirement that makes the product what it
 * was asked for": an owner adds an MCP server in the UI and the agent uses its
 * tools in the very next message, with no restart. So the rows are read on
 * every turn and nothing is cached — a cache with any TTL at all breaks that
 * promise in a way nobody can debug from the outside.
 *
 * ## Where this departs from §6, and why
 *
 * §6 says: *"`allowedTools` accepts wildcards — `mcp__apollo__*` auto-approves
 * a whole server. Use that, combined with the risk classifier."*
 *
 * Those two halves contradict each other in this SDK. A bare `allowedTools`
 * entry — and a wildcard is bare — auto-approves the tool **before
 * `canUseTool` is consulted**, in the SDK's own words. So the wildcard does
 * not combine with the risk classifier; it replaces it. §2.4 says everything
 * that leaves the building goes through the approval queue, §2 is labelled
 * hard constraints, and §2 wins. `allowedTools` stays empty and every
 * connector call reaches the gate, where `classifyRisk` rates an unreviewed
 * third-party tool `high` and a person decides.
 *
 * The cost is real and is not hidden: a connector's tools each need a human
 * the first time and every time. That is the correct default for a server
 * nobody in this codebase has read, and the place to relax it is a per-tool
 * review recorded in the database — not a wildcard that turns the gate off.
 *
 * ## Credentials
 *
 * `revealSecret` is called here and the plaintext goes straight into a header
 * or a child process's environment. It is never logged, never returned, never
 * put in an error message, and never reaches the model: §2.3 says the agent is
 * never handed a raw key, and the agent's context contains only the server's
 * NAME.
 */
import type { AgencyDb, ConnectorRow } from '@agency/db'
import {
  enabledConnectors, isReachableConnectorUrl, parseConnectorConfig, revealSecret,
  type HttpConfig, type StdioConfig,
} from '@agency/db'
import type { Logger } from '../logger.js'

/**
 * The subset of the SDK's `McpServerConfig` this builds.
 *
 * Written out rather than imported so this module can be tested without the
 * SDK, and so a field the SDK adds later cannot appear here by accident. The
 * options builder checks it against the real type at the one call site.
 */
export type BuiltMcpServer =
  | { readonly type: 'stdio'; readonly command: string; readonly args: string[]; readonly env: Record<string, string> }
  | { readonly type: 'http' | 'sse'; readonly url: string; readonly headers: Record<string, string> }

export interface BuildResult {
  readonly servers: Record<string, BuiltMcpServer>
  /** Rows that were enabled but could not be built, and why. For the log. */
  readonly skipped: readonly { readonly name: string; readonly why: string }[]
}

/**
 * How a credential reaches a connector.
 *
 * `Authorization: Bearer <secret>` for http and sse; `MCP_SECRET` in the
 * environment for stdio. Fixed rather than configurable on purpose: a
 * per-connector "which header?" field is a field somebody fills in with the
 * secret itself, and `config` is plain `jsonb`.
 */
const SECRET_HEADER = 'authorization'
const SECRET_ENV = 'MCP_SECRET'

/**
 * Build the `mcpServers` option from this org's enabled connectors.
 *
 * A row that cannot be built is SKIPPED, not thrown on. One malformed
 * connector must not take the whole chat down — the agent should keep working
 * with the tools that are fine, and the settings screen is where the broken
 * one gets fixed. Every skip is logged with the reason.
 */
export async function buildMcpServers(
  db: AgencyDb,
  orgId: string,
  masterKey: Buffer | null,
  log: Logger,
): Promise<BuildResult> {
  const rows = await enabledConnectors(db, orgId)
  const servers: Record<string, BuiltMcpServer> = {}
  const skipped: { name: string; why: string }[] = []

  for (const row of rows) {
    const built = await buildOne(db, row, masterKey, log)
    if ('why' in built) {
      skipped.push({ name: row.name, why: built.why })
      log.warn('connector skipped', { connector: row.name, kind: row.kind, why: built.why })
      continue
    }
    servers[row.name] = built.server
  }

  return { servers, skipped }
}

async function buildOne(
  db: AgencyDb,
  row: ConnectorRow,
  masterKey: Buffer | null,
  log: Logger,
): Promise<{ server: BuiltMcpServer } | { why: string }> {
  const parsed = parseConnectorConfig(row.kind, row.config)
  if (!parsed.ok) return { why: parsed.message }

  // The credential, read at the moment of use and held for as long as it takes
  // to put it in a header. Nothing caches it and nothing logs it.
  let secret: string | null = null
  if (row.secretRef) {
    if (!masterKey) return { why: 'SECRETS_KEY is not set, so its credential cannot be read.' }
    try {
      secret = await revealSecret(db, row.orgId, row.secretRef, masterKey)
    } catch (err) {
      // The message from `revealSecret` is safe (it names a key version, never
      // a value), but it is not worth trusting that forever.
      log.error('could not read a connector credential', {
        connector: row.name,
        error: err instanceof Error ? err.name : 'UnknownError',
      })
      return { why: 'Its credential could not be decrypted. Re-enter it in Settings.' }
    }
    if (!secret) return { why: 'Its credential is missing. Re-enter it in Settings.' }
  }

  if (row.kind === 'stdio') {
    const config = parsed.value as StdioConfig
    return {
      server: {
        type: 'stdio',
        command: config.command,
        args: config.args,
        // The child inherits NOTHING from the worker's environment. Otherwise
        // a connector an owner installed would be handed ANTHROPIC_API_KEY,
        // DATABASE_URL and SECRETS_KEY — every credential the product has, to
        // a process chosen through a web form.
        env: { ...config.env, ...(secret ? { [SECRET_ENV]: secret } : {}) },
      },
    }
  }

  const config = parsed.value as HttpConfig
  if (!isReachableConnectorUrl(config.url)) {
    // Re-checked at BUILD time, not only when the row was written. A row can
    // predate this rule, and the check is cheap.
    return { why: 'Its URL points inside the network the worker runs in.' }
  }
  return {
    server: {
      type: row.kind === 'sse' ? 'sse' : 'http',
      url: config.url,
      headers: {
        ...config.headers,
        ...(secret ? { [SECRET_HEADER]: `Bearer ${secret}` } : {}),
      },
    },
  }
}

/**
 * What the log and the health endpoint may say about a connector.
 *
 * Names and transports only. A URL can carry a token in a query string despite
 * every instruction not to put one there, and a stdio command line can carry
 * one as an argument — so neither is ever logged.
 */
export function describeServers(servers: Record<string, BuiltMcpServer>): string[] {
  return Object.entries(servers).map(([name, s]) => `${name} (${s.type})`)
}
