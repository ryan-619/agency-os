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
 *
 * WHERE it goes is the row's to say, as a NAME: `secretPlacement` for http and
 * sse (a header and the text before the value), `secretEnvName` for stdio. Both
 * live in `@agency/db` beside the schema that validates them, so the web form
 * and this builder cannot disagree about where a credential lands.
 *
 * ## A stdio child and the CLI's own environment
 *
 * The `env` this module emits is exactly `config.env` plus the credential, and
 * that is what `test/connectors.test.ts` asserts of the object. It is NOT what
 * the child receives. The CLI spawns a stdio server with
 * `{ ...its own environment, ...env }` — read from the installed binary, not
 * assumed — and its own environment is
 * `childEnv()`, which on the api_key path carries ANTHROPIC_API_KEY. So every
 * stdio connector was being handed the key that bills the agency, one process
 * down from the place this file was careful not to put it.
 *
 * The child is therefore launched through `env -u …`, which removes those
 * variables after the CLI has merged them in and then execs the real command.
 * `env` replaces itself, so the connector's own argv is unchanged and `ps`
 * shows nothing new. What this does NOT fix, stated rather than hidden: the
 * SDK passes the whole `mcpServers` object to the CLI as `--mcp-config <json>`
 * on ITS argv, decrypted credentials included, for every transport.
 */
import type { AgencyDb, ConnectorRow } from '@agency/db'
import {
  enabledConnectors, isReachableConnectorUrl, parseConnectorConfig, revealSecret, secretEnvName,
  secretPlacement, type HttpConfig, type StdioConfig,
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
 * What the CLI's environment carries that a stdio connector must never see.
 *
 * `childEnv()` in `options.ts` is the CLI's environment, and the CLI's
 * environment is the base every stdio child's is merged onto. These are the
 * names in it — or that the CLI reads from it — that carry a credential or
 * the agency's Anthropic account. `test/connectors.test.ts` walks `childEnv()`
 * and fails on any name it emits that is neither scrubbed here nor on its
 * short list of things a child may see, so a variable added there later has
 * to be decided about here.
 */
export const SCRUBBED_FROM_STDIO: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

/**
 * The launcher. An absolute path rather than a PATH lookup, and not a new
 * dependency: every `npx` server already needs it, because `npx` is a script
 * whose first line is `#!/usr/bin/env node`. GNU, BusyBox (the alpine image)
 * and BSD `env` all take `-u NAME` and `--`.
 */
export const STDIO_LAUNCHER = '/usr/bin/env'

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
    const built = await buildConnector(db, row, masterKey, log)
    if ('why' in built) {
      skipped.push({ name: row.name, why: built.why })
      log.warn('connector skipped', { connector: row.name, kind: row.kind, why: built.why })
      continue
    }
    servers[row.name] = built.server
  }

  return { servers, skipped }
}

/**
 * Build ONE row, enabled or not.
 *
 * Exported for Test connection, which by definition runs on a connector that
 * is still disabled — a server is enabled only after a person has seen it
 * respond. The probe uses this rather than a builder of its own, so "Test
 * connection passed" means the thing a turn would build is the thing that
 * answered.
 */
export async function buildConnector(
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
    // `env` reads every leading NAME=VALUE argument as an assignment, `--` or
    // not, so a command containing `=` would be run as something else.
    if (config.command.includes('=')) {
      return { why: 'Its command contains "=", which cannot be launched with the worker’s credentials removed.' }
    }
    // Refused rather than silently removed by the launcher below: a variable
    // somebody set that never arrives is a connector that fails for no reason
    // anyone can see.
    const claimed = Object.keys(config.env).find((name) => SCRUBBED_FROM_STDIO.includes(name))
    if (claimed) return { why: `Its environment sets ${claimed}, which belongs to the worker.` }
    return {
      server: {
        type: 'stdio',
        command: STDIO_LAUNCHER,
        args: [...SCRUBBED_FROM_STDIO.flatMap((name) => ['-u', name]), '--', config.command, ...config.args],
        // What THIS module hands the child: `config.env` and the credential
        // under the name the row gives, nothing from `process.env`. Otherwise a
        // connector an owner installed would be handed DATABASE_URL and
        // SECRETS_KEY — every credential the product has, to a process chosen
        // through a web form. The launcher above removes what the CLI adds.
        env: { ...config.env, ...(secret ? { [secretEnvName(config)]: secret } : {}) },
      },
    }
  }

  const config = parsed.value as HttpConfig
  if (!isReachableConnectorUrl(config.url)) {
    // Re-checked at BUILD time, not only when the row was written. A row can
    // predate this rule, and the check is cheap.
    return { why: 'Its URL points inside the network the worker runs in.' }
  }
  // The header and scheme the row names: `authorization: Bearer` unless it
  // says otherwise (`x-api-key` bare, `authorization: Sentry-Bearer`). The
  // schema refuses a `headers` entry under the same name, so the spread order
  // below never decides anything.
  const { header, prefix } = secretPlacement(config)
  return {
    server: {
      type: row.kind === 'sse' ? 'sse' : 'http',
      url: config.url,
      headers: {
        ...config.headers,
        ...(secret ? { [header]: `${prefix}${secret}` } : {}),
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
