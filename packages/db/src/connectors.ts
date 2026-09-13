/**
 * The connector registry (PROMPT.md §6).
 *
 * "New tools must be addable from inside the software, without a code change
 * or a redeploy." Each row is one MCP server; the worker builds the SDK's
 * `mcpServers` option from the enabled ones on every turn, so a server added
 * in the UI is usable in the next message.
 *
 * This module owns what a row MEANS — the config shape per transport, and the
 * queries. Two callers need exactly the same answer and must not each have
 * their own idea of it: the web app, validating a form before it writes a row,
 * and the worker, reading that row back to build a live connection. A shape
 * that disagrees between them is a connector that saves cleanly and then fails
 * at the only moment anyone would notice.
 *
 * It deliberately does NOT build the SDK option. That lives in the worker,
 * because it needs the decrypted credential and because nothing in a package
 * may import the Agent SDK (see CLAUDE.md §2, packages/tools).
 *
 * **A `stdio` connector runs a command on the worker host.** That is what §6
 * asks for and it is worth saying out loud: an owner who adds one is
 * installing software, not configuring an integration. `connectors:write` is
 * owner-only for this reason, and the UI says so on the form rather than in a
 * tooltip.
 */
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type ConnectorRow = typeof schema.connectors.$inferSelect

export const CONNECTOR_KINDS = ['stdio', 'http', 'sse'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * The server-name shape, matching `connectors_name_is_a_valid_mcp_server_name`
 * in the database and `MCP_SERVER_NAME` in the risk classifier.
 *
 * All three have to agree: a tool is addressed as `mcp__<server>__<tool>`, so
 * a name containing `__` makes that string ambiguous, and the classifier
 * cannot then tell which server a call belongs to. The constraint is the
 * enforcement; this is the same rule stated where a form can use it.
 */
export const connectorNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'Use lower-case letters, digits and hyphens — this becomes part of every tool name.',
  )

/** A header value may not be a credential. Credentials go in `secret_ref`. */
const headerValue = z.string().max(4096)

const stdioConfig = z.object({
  command: z.string().min(1, 'A command is required.'),
  args: z.array(z.string()).max(64).default([]),
  /**
   * Environment for the child process. NOT a place for a credential: the
   * worker injects the decrypted secret at launch, and anything typed here is
   * stored in plain `jsonb` where §2.3 says a credential may never be.
   */
  env: z.record(z.string(), z.string().max(4096)).default({}),
})

const httpConfig = z.object({
  url: z.url('Must be an absolute http(s) URL.'),
  headers: z.record(z.string(), headerValue).default({}),
})

export type StdioConfig = z.infer<typeof stdioConfig>
export type HttpConfig = z.infer<typeof httpConfig>
export type ConnectorConfig = StdioConfig | HttpConfig

/**
 * Validate a connector's config for its transport.
 *
 * Returns a result rather than throwing: both callers want to show the message
 * to a person, and neither wants a 500.
 */
export function parseConnectorConfig(
  kind: string,
  config: unknown,
): { ok: true; value: ConnectorConfig } | { ok: false; message: string } {
  const shape = kind === 'stdio' ? stdioConfig : kind === 'http' || kind === 'sse' ? httpConfig : null
  if (!shape) {
    return { ok: false, message: `"${kind}" is not a transport. Use stdio, http or sse.` }
  }
  const parsed = shape.safeParse(config ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.join('.')
    return { ok: false, message: `${where ? `${where}: ` : ''}${first?.message ?? 'Invalid config.'}` }
  }
  return { ok: true, value: parsed.data }
}

/**
 * Refuse a URL that points back inside the network the worker runs in.
 *
 * The scanner has the same rule for the same reason and the reasoning is in
 * `packages/scanner`: a connector URL is an outbound request built from a
 * string somebody typed, and `http://169.254.169.254/` is the cloud metadata
 * endpoint. The difference here is that the worker would send the connector's
 * CREDENTIAL along with it.
 *
 * Like the scanner's, this does not resolve DNS — a public name pointing at a
 * private address still gets through, and that needs a connect-time check.
 * It is a guard against a mistake and a casual attempt, not against a
 * determined one.
 */
export function isReachableConnectorUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false
  for (const suffix of ['.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp']) {
    if (host.endsWith(suffix)) return false
  }
  // A bare label with no dot is an internal hostname: `metadata`, `redis`, or
  // a docker service name.
  return host.includes('.')
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listConnectors(db: AgencyDb, orgId: string): Promise<ConnectorRow[]> {
  return db
    .select()
    .from(schema.connectors)
    .where(eq(schema.connectors.orgId, orgId))
    .orderBy(asc(schema.connectors.name))
}

/**
 * What the worker assembles a turn from.
 *
 * Read fresh on every turn, never cached: §6's whole promise is that a server
 * added in the UI works in the very next message, and a cache with any TTL at
 * all breaks that in a way nobody can debug from the outside.
 */
export async function enabledConnectors(db: AgencyDb, orgId: string): Promise<ConnectorRow[]> {
  return db
    .select()
    .from(schema.connectors)
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.enabled, true)))
    .orderBy(asc(schema.connectors.name))
}

export async function readConnector(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<ConnectorRow | null> {
  const rows = await db
    .select()
    .from(schema.connectors)
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export interface ConnectorInput {
  readonly orgId: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly config: ConnectorConfig
  readonly secretRef?: string | null
  readonly createdBy?: string | null
}

/**
 * Add a connector.
 *
 * Always DISABLED. A server is enabled by a separate, deliberate action after
 * Test connection has passed — so a typo in a URL cannot put a broken server
 * into the next chat message, and nobody enables something they have not seen
 * respond.
 */
export async function createConnector(db: AgencyDb, input: ConnectorInput): Promise<ConnectorRow> {
  const rows = await db
    .insert(schema.connectors)
    .values({
      orgId: input.orgId,
      name: input.name,
      kind: input.kind,
      enabled: false,
      config: input.config,
      secretRef: input.secretRef ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('connector insert returned no row')
  return row
}

export async function updateConnector(
  db: AgencyDb,
  orgId: string,
  id: string,
  patch: {
    readonly config?: ConnectorConfig
    readonly secretRef?: string | null
    readonly kind?: ConnectorKind
  },
): Promise<ConnectorRow | null> {
  const rows = await db
    .update(schema.connectors)
    .set({
      ...(patch.config ? { config: patch.config } : {}),
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.secretRef !== undefined ? { secretRef: patch.secretRef } : {}),
      // Any change re-disables. The connection that was tested is not the one
      // now configured, and an edited-and-still-enabled server is a live
      // connection nobody has verified.
      enabled: false,
      lastOkAt: null,
      lastError: null,
    })
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .returning()
  return rows[0] ?? null
}

export async function setConnectorEnabled(
  db: AgencyDb,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<ConnectorRow | null> {
  const rows = await db
    .update(schema.connectors)
    .set({ enabled })
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .returning()
  return rows[0] ?? null
}

export async function deleteConnector(db: AgencyDb, orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.connectors)
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
    .returning({ id: schema.connectors.id })
  return rows.length === 1
}

/**
 * Record what Test connection found.
 *
 * `last_error` is deliberately capped and is written from a message the worker
 * has already sanitised: a transport error can carry the URL, and the URL can
 * carry a token in a query string that someone pasted despite being told not
 * to. §2.3 does not have an exception for error text.
 */
export async function recordConnectorProbe(
  db: AgencyDb,
  orgId: string,
  id: string,
  result: { readonly ok: true } | { readonly ok: false; readonly error: string },
): Promise<void> {
  await db
    .update(schema.connectors)
    .set(
      result.ok
        ? { lastOkAt: new Date(), lastError: null }
        : { lastError: result.error.slice(0, 500) },
    )
    .where(and(eq(schema.connectors.orgId, orgId), eq(schema.connectors.id, id)))
}
