/**
 * The `agency` MCP server (PROMPT.md §6).
 *
 * This is the ONLY file in the project that imports the Agent SDK's tool
 * helpers. `packages/tools` holds the tools as plain data precisely so that
 * everything testable about them can be tested without the SDK — there is no
 * mock transport and no recorded-session mode, so an SDK-shaped tool is an
 * untestable tool. What is left here is an adapter thin enough to read in one
 * sitting.
 *
 * The one piece of logic it does carry is the ledger check, and that is the
 * point of putting the handler in-process: a call that reached this function
 * without passing the gate has no grant, and fails here — inside our own code,
 * needing nothing from the SDK to be true.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { canonicalJson } from '@agency/db'
import { AGENCY_TOOLS, type AgencyToolSpec, type ToolContext } from '@agency/tools'
import { fingerprint, type AuthorisationLedger } from '../gate/ledger.js'

export interface McpDeps {
  readonly context: () => ToolContext
  readonly ledger: AuthorisationLedger
  readonly turnId: () => string
  /** Called when a tool runs that the gate never authorised. */
  readonly onBypass: (toolName: string) => void
  readonly log: { error: (msg: string, fields?: Record<string, unknown>) => void }
}

/** A hard wall clock per call, so a hung scan cannot hold the turn open. */
export const TOOL_TIMEOUT_MS = 30_000

/**
 * Validate a tool's arguments outside the SDK.
 *
 * The gate needs to parse the same input the handler will receive, so that the
 * fingerprint it grants matches the one the handler computes. Sharing this
 * function is what keeps the two in step.
 */
export function makeInputParser(): (
  toolName: string,
  input: Record<string, unknown>,
) => { ok: boolean; value?: unknown; message?: string } {
  const byName = new Map<string, AgencyToolSpec>()
  for (const spec of AGENCY_TOOLS) byName.set(`mcp__agency__${spec.name}`, spec)

  return (toolName, input) => {
    const spec = byName.get(toolName)
    // Not one of ours — a connector tool, whose schema we do not have. The
    // risk classifier already sends those to a human; there is nothing to
    // validate against, so the input passes through untouched.
    if (!spec) return { ok: true, value: input }
    const parsed = z.object(spec.shape).safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      }
    }
    return { ok: true, value: parsed.data }
  }
}

export function createAgencyMcpServer(deps: McpDeps) {
  const tools = AGENCY_TOOLS.map((spec) =>
    tool(
      spec.name,
      spec.description,
      spec.shape,
      async (args: unknown) => {
        const qualified = `mcp__agency__${spec.name}`

        // The ledger check. A call that did not come through the gate has no
        // grant — and that is the only signal available for a bypass nobody
        // has enumerated, so it halts the runtime rather than merely refusing.
        const fp = fingerprint(deps.turnId(), qualified, canonicalJson(args))
        if (!deps.ledger.consume(fp)) {
          deps.onBypass(qualified)
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `${spec.name} was not authorised. Every tool call in Agency OS is checked by a ` +
                  'permission gate first, and this one was not. Nothing was done. Tell the user the ' +
                  'agent runtime has stopped and stop.',
              },
            ],
            isError: true,
          }
        }

        try {
          const outcome = await spec.handler(args as never, deps.context())
          if (!outcome.ok) {
            return {
              content: [{ type: 'text' as const, text: `${outcome.code}: ${outcome.message}` }],
              isError: true,
            }
          }
          return { content: [{ type: 'text' as const, text: outcome.summary }] }
        } catch (err) {
          // One tool failing is not the turn failing. The model is told
          // plainly and can decide what to do next.
          deps.log.error('agency tool threw', {
            tool: spec.name,
            error: err instanceof Error ? err.name : 'UnknownError',
          })
          return {
            content: [
              {
                type: 'text' as const,
                text: `${spec.name} failed. Nothing was changed. Tell the user and do not retry it blindly.`,
              },
            ],
            isError: true,
          }
        }
      },
    ),
  )

  return createSdkMcpServer({
    name: 'agency',
    version: '1.0.0',
    instructions:
      'The agency CRM: companies, people, scans, findings, scores, campaigns, drafts, deals, meetings, ' +
      'proposals, tasks and the worker that sends. Reads and scans run at once; every change asks a person ' +
      'first, and anything that drafts a message to someone outside the company is approved before it is ' +
      'written and again before it is sent.',
    tools,
    timeout: TOOL_TIMEOUT_MS,
  })
}
