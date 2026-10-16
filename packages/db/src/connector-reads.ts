/**
 * A research connector an owner lets run without a card (2026-10-07).
 *
 * Every connector tool reaches a person by default: `classifyRisk` rates an
 * unreviewed third-party tool `high`, and each call parks on an approval card.
 * That is right for a server that can send, post or change things somewhere
 * else — and it made the agent useless at the one job the team asks of it
 * most, finding companies: a search is a dozen calls, and a dozen cards is a
 * person doing the search by hand.
 *
 * So ONE narrow allow exists, and it is an owner's to give, per connector:
 *
 *  - only for a server the catalog marks `readOnly` — Exa, Firecrawl, Tavily,
 *    Jina, Context7, DeepWiki, Cloudflare's docs — matched by the row's
 *    endpoint as `sendTools` is, so a hand-typed URL for the same server is
 *    that server and nothing else ever qualifies (no stdio server does: its
 *    command line is not an identity);
 *  - only while `config.readsWithoutCard` is true, which defaults OFF and is
 *    written by `connectorReadsSet` alone, behind `connectors:write`;
 *  - never in a turn nobody is watching — the morning brief may only read and
 *    scan the agency's own tools — and never past `disabledTools`, which the
 *    gate asks first;
 *  - and the call is still audited (`agent.tool_allow`, rule
 *    `connector_read`) and still single-use in the ledger, exactly as a read
 *    of the agency's own is.
 *
 * What such a server returns is the open web: data, never instructions. The
 * system prompt says so, and nothing the agent can do without a card reaches
 * anybody outside the agency.
 *
 * The key is deliberately NOT in the connector config schema: a config
 * rewritten from the form (a changed URL or credential) drops it, so a
 * re-pointed connector is never left switched on by accident.
 */
import { and, eq, sql } from 'drizzle-orm'
import { connectorToolsEveryTool, connectorToolsPreset, type ConnectorToolsRow } from './connector-tools.js'
import { readConnector, type ConnectorRow } from './connectors.js'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export interface ConnectorReadsState {
  /** The row points at a catalog server marked read-only — the only kind the switch applies to. */
  readonly eligible: boolean
  /** Switched on by an owner AND eligible now. A stored true on a re-pointed row reads as off. */
  readonly on: boolean
  /** The catalog entry's title, or null. */
  readonly preset: string | null
}

export function connectorReadsState(row: ConnectorToolsRow): ConnectorReadsState {
  const preset = connectorToolsPreset(row)
  const eligible = preset?.readOnly === true
  const stored = (row.config as { readsWithoutCard?: unknown } | null)?.readsWithoutCard === true
  return { eligible, on: eligible && stored, preset: preset?.title ?? null }
}

/**
 * What the gate lets run without a card on this row: `mcp__<name>__*` when the
 * switch is on, nothing otherwise. The same entry shape `disabledTools` uses,
 * read with the same matcher (`connectorToolsMatch`).
 */
export function connectorReadsAllowed(row: ConnectorToolsRow): ReadonlySet<string> {
  return connectorReadsState(row).on ? new Set([connectorToolsEveryTool(row.name)]) : new Set()
}

export type ConnectorReadsSetResult =
  | { readonly ok: true; readonly row: ConnectorRow; readonly before: boolean }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_eligible' }

/**
 * Switch it on or off: ONE key of `config`, by `jsonb_set`, and nothing else —
 * not `enabled`, not `last_ok_at` — as `connectorToolsSetDisabled` does, and
 * for its reason. On is refused for a server the catalog does not mark
 * read-only; off is always allowed.
 */
export async function connectorReadsSet(
  db: AgencyDb,
  orgId: string,
  id: string,
  on: boolean,
): Promise<ConnectorReadsSetResult> {
  const row = await readConnector(db, orgId, id)
  if (!row) return { ok: false, reason: 'not_found' }
  const state = connectorReadsState(row)
  if (on && !state.eligible) return { ok: false, reason: 'not_eligible' }
  const rows = await db
    .update(schema.connectors)
    .set({
      config: sql`jsonb_set(${schema.connectors.config}, '{readsWithoutCard}', ${JSON.stringify(on)}::jsonb, true)`,
    })
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .returning()
  const updated = rows[0]
  return updated ? { ok: true, row: updated, before: state.on } : { ok: false, reason: 'not_found' }
}
