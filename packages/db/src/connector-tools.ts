/**
 * Turning a connector's tools OFF (connector-tool-disable).
 *
 * Every connector tool already reaches a person: `classifyRisk` rates an
 * unreviewed third-party tool `high`, so each call parks on an approval card.
 * This module adds the other direction and only that direction — a tool an
 * owner has switched off is REFUSED, in both gate rings, before
 * classification, without a card and without asking anybody. It adds no
 * allow anywhere. There is no function in this file that can make a tool
 * run that would not have run before it existed.
 *
 * ## What is off, and who decided
 *
 * `config.disabledTools` is `optional()` in the schema rather than
 * defaulted, and that gives the stored list a third state for free:
 *
 *  - **present** — an owner saved a list (possibly empty). That list, exactly.
 *  - **absent, and the row points at a catalog server with `sendTools`** —
 *    the catalog's default. Stripe's refunds and payouts, Intercom's notes;
 *    and for Zapier and Apollo, whose catalog entry is `['*']` because every
 *    tool acts on another SaaS, EVERY tool on the server.
 *  - **absent otherwise** — nothing is off.
 *
 * The catalog default is read from the row's endpoint on every turn rather
 * than written into the row at install, for the reason the design review
 * gave: `'*'` cannot be stored (a tool name has no `*` in it) and cannot be
 * expanded either, because the list it would expand to comes from Test
 * connection, which has not run when the row is created. Deriving it means
 * "disabled until you turn them on" is true from the moment the row exists,
 * whichever form added it — a Zapier typed in by hand is still Zapier.
 *
 * `'*'` crosses to the gate as the entry `mcp__<name>__*`. No real tool can
 * collide with it: the risk classifier's tool-name shape has no `*` in it,
 * and neither does the stored one.
 *
 * ## Why the writer does not re-disable the connector
 *
 * `updateConnector` sets `enabled = false` and forgets `last_ok_at` on any
 * change, because a changed URL or credential is a connection nobody has
 * seen answer. Narrowing what a server may do is not a change to where it
 * points: the thing that was tested is still the thing configured. So
 * `connectorToolsSetDisabled` writes ONE key of `config` with `jsonb_set` and
 * nothing else — re-disabling here would punish exactly the owner who is
 * making a live connector safer, and teach them to stop doing it.
 *
 * Tool NAMES only, here, in the audit log and in the log (§2.3). A name is
 * not a credential; nothing in this file reads one.
 */
import { and, eq, sql } from 'drizzle-orm'
import { CONNECTOR_CATALOG, type ConnectorPreset } from '@agency/core'
import { disabledToolNames, parseConnectorConfig, readConnector, type ConnectorRow } from './connectors.js'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

/** The fields of a row these functions read. A `ConnectorRow` is one. */
export interface ConnectorToolsRow {
  readonly name: string
  readonly kind: string
  readonly config: unknown
}

/** What is refused on one server, and who decided. Bare tool names. */
export interface ConnectorToolsState {
  /**
   * `owner` — a person saved this list. `catalog` — nobody has, and the row
   * points at a catalog server whose entry names send tools. `none` — neither.
   */
  readonly source: 'owner' | 'catalog' | 'none'
  /** Bare tool names refused. Empty when `everyTool` is. */
  readonly tools: readonly string[]
  /** Every tool on the server is refused: a `'*'` catalog entry nobody has reviewed yet. */
  readonly everyTool: boolean
  /** The title of the catalog entry this row's endpoint matches, or null. */
  readonly preset: string | null
}

/** The gate's entry for "every tool on this server". Never a real tool name. */
export function connectorToolsEveryTool(server: string): string {
  return `mcp__${server}__*`
}

/**
 * The catalog preset whose endpoint this row points at, or null.
 *
 * Matched on origin and path, ignoring the query string and a trailing slash,
 * and ignoring http-versus-sse: the same server under either transport is the
 * same server. Ignoring the query errs toward MORE refusal, which is the safe
 * direction for a function whose only effect is to refuse.
 *
 * Only http and sse rows match. No stdio preset names a send tool today, and
 * `connector-tools.test.ts` fails if one ever does, so this is decided when
 * it matters rather than guessed at now.
 */
export function connectorToolsPreset(row: Pick<ConnectorToolsRow, 'kind' | 'config'>): ConnectorPreset | null {
  if (row.kind !== 'http' && row.kind !== 'sse') return null
  const url = endpoint((row.config as { url?: unknown } | null)?.url)
  if (!url) return null
  for (const preset of CONNECTOR_CATALOG) {
    if (preset.kind === 'stdio') continue
    if (endpoint((preset.config as { url?: unknown }).url) === url) return preset
  }
  return null
}

function endpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** What is off on this row. See the module comment for the three states. */
export function connectorToolsState(row: ConnectorToolsRow): ConnectorToolsState {
  const preset = connectorToolsPreset(row)
  const title = preset?.title ?? null
  const stored = (row.config as { disabledTools?: unknown } | null)?.disabledTools
  if (Array.isArray(stored)) {
    // Read through the schema's own reader, so a list it would refuse turns
    // nothing off here either — and the worker skips such a row anyway,
    // because the whole config then fails to parse.
    const prefix = `mcp__${row.name}__`
    const tools = [...disabledToolNames(row)].map((full) => full.slice(prefix.length))
    return { source: 'owner', tools, everyTool: false, preset: title }
  }
  if (preset && preset.sendTools.length > 0) {
    const everyTool = preset.sendTools.includes('*')
    return {
      source: 'catalog',
      tools: everyTool ? [] : [...preset.sendTools],
      everyTool,
      preset: title,
    }
  }
  return { source: 'none', tools: [], everyTool: false, preset: title }
}

/**
 * What the gate refuses for this row, as the gate sees tool names:
 * `mcp__<name>__<tool>`, plus `mcp__<name>__*` when every tool is off.
 */
export function connectorToolsDenied(row: ConnectorToolsRow): ReadonlySet<string> {
  const state = connectorToolsState(row)
  const out = new Set(state.tools.map((tool) => `mcp__${row.name}__${tool}`))
  if (state.everyTool) out.add(connectorToolsEveryTool(row.name))
  return out
}

/**
 * Is this call one an owner turned off? Exact name, or its server's `*`.
 *
 * The one predicate both gate rings ask, so they cannot disagree about what
 * is disabled. Pure and total: any string in, a boolean out, nothing thrown.
 */
export function connectorToolsIsDisabled(disabled: ReadonlySet<string>, toolName: string): boolean {
  if (disabled.size === 0 || typeof toolName !== 'string') return false
  if (disabled.has(toolName)) return true
  if (!toolName.startsWith('mcp__')) return false
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0) return false
  return disabled.has(connectorToolsEveryTool(rest.slice(0, cut)))
}

/**
 * Validate a list of tool names for this row, before anything is written.
 *
 * Validated as the WHOLE config the write would leave behind, through
 * `parseConnectorConfig` — the function the worker reads the row back with.
 * A list the schema refuses would make the worker skip the connector
 * entirely on the next turn, which is not what "turn off two tools" asked
 * for. Duplicates are dropped and the list is sorted, so the stored value
 * and the audit row say the same thing whatever order the boxes were ticked.
 */
export function connectorToolsCheck(
  row: Pick<ConnectorToolsRow, 'kind' | 'config'>,
  tools: unknown,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(tools) || !tools.every((t): t is string => typeof t === 'string')) {
    return { ok: false, message: 'disabledTools must be a list of tool names.' }
  }
  const base = parseConnectorConfig(row.kind, row.config)
  if (!base.ok) {
    return {
      ok: false,
      message: `This connector’s settings do not validate (${base.message}), so its tool list cannot be saved.`,
    }
  }
  const value = [...new Set(tools)].sort()
  const withList = (list: readonly string[]) =>
    parseConnectorConfig(row.kind, { ...(row.config as Record<string, unknown>), disabledTools: list })
  const merged = withList(value)
  if (!merged.ok) {
    // The schema names an index into a list the person never saw sorted;
    // name the tool instead, when one on its own is the problem.
    const culprit = value.find((tool) => !withList([tool]).ok)
    return {
      ok: false,
      message: culprit !== undefined ? `"${culprit}" cannot be stored as a tool name. ${merged.message}` : merged.message,
    }
  }
  return { ok: true, value }
}

/**
 * Store the list of tools an owner turned off. ONE UPDATE of one key.
 *
 * Returns null when the row is not this org's. Throws when the list does not
 * pass `connectorToolsCheck` — a caller is expected to have asked first, and
 * to have shown the person the message; reaching the write with a bad list
 * is a bug, not a form error.
 *
 * `enabled`, `last_ok_at`, `last_error`, the credential and every other key
 * of `config` are untouched — see the module comment for why.
 */
export async function connectorToolsSetDisabled(
  db: AgencyDb,
  orgId: string,
  id: string,
  tools: readonly string[],
): Promise<ConnectorRow | null> {
  const row = await readConnector(db, orgId, id)
  if (!row) return null
  const checked = connectorToolsCheck(row, tools)
  if (!checked.ok) throw new Error(checked.message)
  const rows = await db
    .update(schema.connectors)
    .set({
      config: sql`jsonb_set(${schema.connectors.config}, '{disabledTools}', ${JSON.stringify(checked.value)}::jsonb, true)`,
    })
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .returning()
  return rows[0] ?? null
}
