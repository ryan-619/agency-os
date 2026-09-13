/**
 * Subagent definitions as data (PROMPT.md §7).
 *
 * `agent_defs` rows become the SDK's `agents` option on every turn, the same
 * way connectors become `mcpServers` — so a definition edited in Settings is
 * live in the next message.
 *
 * The mapping itself is NOT here. It lives in `apps/agent/src/runtime/agents.ts`
 * with a frozen key whitelist, because `AgentDefinition` in this SDK carries
 * `permissionMode` among other things and a row written through a web form
 * must never be able to reach it. This module is the rows and what makes one
 * valid before it is stored.
 */
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'

export type AgentDefRow = typeof schema.agentDefs.$inferSelect

/**
 * A slug becomes the subagent's name in the SDK and in every audit row that
 * mentions it. Kept to the same shape as an MCP server name so that neither
 * can contain something that changes how a tool name parses.
 */
export const agentSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lower-case letters, digits and hyphens.')

/**
 * The models a definition may name — the SDK's own aliases, not a free string.
 *
 * `model` is passed to the SDK, and a typo fails at the first delegation with
 * nothing pointing back at the settings screen that caused it.
 */
export const AGENT_MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'] as const

export const agentDefInput = z.object({
  slug: agentSlugSchema,
  name: z.string().min(1).max(80),
  /** The model reads this to decide when to delegate, so it is required. */
  description: z.string().min(10, 'Say when this agent should be used — the model reads it.').max(1000),
  systemPrompt: z.string().min(10, 'An agent with no instructions is a worse version of the main one.').max(20_000),
  tools: z.array(z.string().max(120)).max(64).default([]),
  model: z.enum(AGENT_MODELS).optional(),
  enabled: z.boolean().default(false),
})

export type AgentDefInput = z.infer<typeof agentDefInput>

export async function listAgentDefs(db: AgencyDb, orgId: string): Promise<AgentDefRow[]> {
  return db
    .select()
    .from(schema.agentDefs)
    .where(eq(schema.agentDefs.orgId, orgId))
    .orderBy(asc(schema.agentDefs.slug))
}

/**
 * What the worker assembles a turn from. Read fresh every turn, never cached —
 * the same promise §6 makes for connectors.
 */
export async function enabledAgentDefs(db: AgencyDb, orgId: string): Promise<AgentDefRow[]> {
  return db
    .select()
    .from(schema.agentDefs)
    .where(and(eq(schema.agentDefs.orgId, orgId), eq(schema.agentDefs.enabled, true)))
    .orderBy(asc(schema.agentDefs.slug))
}

export async function readAgentDef(
  db: AgencyDb,
  orgId: string,
  id: string,
): Promise<AgentDefRow | null> {
  const rows = await db
    .select()
    .from(schema.agentDefs)
    .where(and(eq(schema.agentDefs.orgId, orgId), eq(schema.agentDefs.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function createAgentDef(
  db: AgencyDb,
  orgId: string,
  input: AgentDefInput,
): Promise<AgentDefRow> {
  const rows = await db
    .insert(schema.agentDefs)
    .values({
      orgId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      model: input.model ?? null,
      enabled: input.enabled,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('agent_def insert returned no row')
  return row
}

export async function updateAgentDef(
  db: AgencyDb,
  orgId: string,
  id: string,
  input: Omit<AgentDefInput, 'slug'>,
): Promise<AgentDefRow | null> {
  const rows = await db
    .update(schema.agentDefs)
    .set({
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      model: input.model ?? null,
      enabled: input.enabled,
    })
    .where(and(eq(schema.agentDefs.orgId, orgId), eq(schema.agentDefs.id, id)))
    .returning()
  return rows[0] ?? null
}

export async function setAgentDefEnabled(
  db: AgencyDb,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<AgentDefRow | null> {
  const rows = await db
    .update(schema.agentDefs)
    .set({ enabled })
    .where(and(eq(schema.agentDefs.orgId, orgId), eq(schema.agentDefs.id, id)))
    .returning()
  return rows[0] ?? null
}

export async function deleteAgentDef(db: AgencyDb, orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.agentDefs)
    .where(and(eq(schema.agentDefs.orgId, orgId), eq(schema.agentDefs.id, id)))
    .returning({ id: schema.agentDefs.id })
  return rows.length === 1
}
