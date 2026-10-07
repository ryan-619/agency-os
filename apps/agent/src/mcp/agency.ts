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
 * needing nothing from the SDK to be true. Below the adapter sits the one
 * question asked of the SDK at boot: can the model be shown every tool?
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { canonicalJson } from '@agency/db'
import { AGENCY_TOOLS, type AgencyToolSpec, type ToolContext } from '@agency/tools'
import { createLedger, fingerprint, type AuthorisationLedger } from '../gate/ledger.js'

export interface McpDeps {
  readonly context: () => ToolContext
  readonly ledger: AuthorisationLedger
  readonly turnId: () => string
  /** Called when a tool runs that the gate never authorised. */
  readonly onBypass: (toolName: string) => void
  readonly log: { error: (msg: string, fields?: Record<string, unknown>) => void }
  /**
   * Tools left out of the server: the ones the SDK cannot describe to the
   * model, found once at boot by `agencyToolsToOmit`. Absent, every tool.
   */
  readonly omit?: ReadonlySet<string> | undefined
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

/**
 * What the model is told about the server, beside each tool's own words. It
 * must say what the gate does (gate/can-use-tool.ts): reads, scans and the
 * team's own records at once, a person first only for what reaches somebody
 * outside, lifts a hold or changes the scoring. It said every change asked a
 * person, after the operator decided on 2026-10-06 that internal writes run at
 * once, and a model told so declines work it was asked to do.
 */
export const AGENCY_SERVER_INSTRUCTIONS =
  'The agency CRM: companies, people, scans, findings, scores, profiles, campaigns, drafts, deals, meetings, ' +
  'proposals, tasks and the worker that sends. Reads, scans and changes to the team’s own records run at once. ' +
  'A person approves first anything that drafts a message to someone outside the company, lets outreach reach ' +
  'somebody again, or changes which profile scores companies — and every message is approved again before it is sent.'

export function createAgencyMcpServer(deps: McpDeps): McpSdkServerConfigWithInstance {
  const omit = deps.omit
  return buildAgencyServer(omit && omit.size > 0 ? AGENCY_TOOLS.filter((spec) => !omit.has(spec.name)) : AGENCY_TOOLS, deps)
}

function buildAgencyServer(specs: readonly AgencyToolSpec[], deps: McpDeps): McpSdkServerConfigWithInstance {
  const tools = specs.map((spec) =>
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
    instructions: AGENCY_SERVER_INSTRUCTIONS,
    tools,
    timeout: TOOL_TIMEOUT_MS,
  })
}

// ---------------------------------------------------------------------------
// Can the model be shown every tool?
//
// The CLI asks the in-process server for its tools (`tools/list`), and the
// SDK turns each tool's zod shape into JSON Schema in that one answer. A shape
// it cannot convert — any `z.record`, measured against 0.3.269 — makes the
// WHOLE answer an error, and the CLI is then left with no agency tool at all:
// every call is "No such tool available", the model works on with the
// connectors alone, and no log line says why. That is what create_icp's
// `weights` did on 2026-10-07. So the worker asks once at boot, the way the
// CLI asks, and leaves out — loudly — any tool that cannot be listed: a bad
// shape costs that tool, never the other fifty.
// ---------------------------------------------------------------------------

/** One JSON-RPC message, as far as a listing reads it. */
interface RpcMessage {
  readonly jsonrpc: '2.0'
  readonly id?: string | number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly message?: unknown }
}

/** How long a listing may take before it counts as failed. */
export const TOOL_LISTING_TIMEOUT_MS = 10_000

export type ToolListing =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly error: string }

type ServerTransport = Parameters<McpSdkServerConfigWithInstance['instance']['connect']>[0]

/**
 * Ask an in-process MCP server for its tools as the CLI does, through MCP's
 * own transport contract — so the request reaches the same handler, and the
 * same conversion of every shape, that a turn's `tools/list` reaches. Never
 * throws. The server is closed afterwards, so pass one built for the purpose.
 */
export async function listServerTools(
  server: McpSdkServerConfigWithInstance,
  timeoutMs: number = TOOL_LISTING_TIMEOUT_MS,
): Promise<ToolListing> {
  const waiting = new Map<string | number, (reply: RpcMessage) => void>()
  const loopback: {
    onmessage?: (message: RpcMessage) => void
    onclose?: () => void
    onerror?: (error: Error) => void
    start(): Promise<void>
    send(message: RpcMessage): Promise<void>
    close(): Promise<void>
  } = {
    async start() {},
    async send(message) {
      // Only answers matter here; the server sends no request of its own.
      if (message.id === undefined || message.method !== undefined) return
      const resolve = waiting.get(message.id)
      waiting.delete(message.id)
      resolve?.(message)
    },
    async close() {
      loopback.onclose?.()
    },
  }
  let next = 0
  const ask = (method: string, params: unknown): Promise<RpcMessage> =>
    new Promise((resolve) => {
      next += 1
      waiting.set(next, resolve)
      loopback.onmessage?.({ jsonrpc: '2.0', id: next, method, params })
    })
  const errorOf = (reply: RpcMessage): string =>
    typeof reply.error?.message === 'string' ? reply.error.message.slice(0, 200) : 'the server answered with an error'

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await server.instance.connect(loopback as unknown as ServerTransport)
    const listing = (async (): Promise<ToolListing> => {
      const init = await ask('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agency-os-tool-check', version: '1.0.0' },
      })
      if (init.error) return { ok: false, error: errorOf(init) }
      loopback.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const listed = await ask('tools/list', {})
      if (listed.error) return { ok: false, error: errorOf(listed) }
      const tools = (listed.result as { tools?: unknown } | undefined)?.tools
      if (!Array.isArray(tools)) return { ok: false, error: 'the answer carried no tool list' }
      return { ok: true, names: tools.map((t) => String((t as { name?: unknown }).name)) }
    })()
    return await Promise.race([
      listing,
      new Promise<ToolListing>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: 'no answer' }), timeoutMs)
      }),
    ])
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : 'UnknownError' }
  } finally {
    clearTimeout(timer)
    await server.instance.close().catch(() => {})
  }
}

/** Deps for a server that is only listed: no tool runs, so nothing here is reached. */
function listingOnly(): McpDeps {
  return {
    context: () => {
      throw new Error('a tool listing runs no tool')
    },
    ledger: createLedger(),
    turnId: () => 'tool-listing',
    onBypass: () => {},
    log: { error: () => {} },
  }
}

/**
 * Which of `specs` the model cannot be shown. The whole set is listed first;
 * only when that fails is each tool listed alone, to name the ones at fault.
 * `error` is set when the set cannot be listed even without them.
 */
export async function unlistableAgencyTools(
  specs: readonly AgencyToolSpec[] = AGENCY_TOOLS,
): Promise<{ readonly unlistable: readonly string[]; readonly error?: string }> {
  const whole = await listServerTools(buildAgencyServer(specs, listingOnly()))
  if (whole.ok) {
    const listed = new Set(whole.names)
    return { unlistable: specs.filter((spec) => !listed.has(spec.name)).map((spec) => spec.name) }
  }
  const unlistable: string[] = []
  for (const spec of specs) {
    const one = await listServerTools(buildAgencyServer([spec], listingOnly()))
    if (!one.ok || !one.names.includes(spec.name)) unlistable.push(spec.name)
  }
  const rest = await listServerTools(buildAgencyServer(specs.filter((spec) => !unlistable.includes(spec.name)), listingOnly()))
  return rest.ok ? { unlistable } : { unlistable, error: rest.error }
}

/**
 * Decided once at boot (worker.ts): the tools every turn's server leaves out,
 * said at error when there are any, because each is a tool the system prompt
 * names and the model will not find.
 */
export async function agencyToolsToOmit(
  log: {
    readonly info: (msg: string, fields?: Record<string, unknown>) => void
    readonly error: (msg: string, fields?: Record<string, unknown>) => void
  },
  specs: readonly AgencyToolSpec[] = AGENCY_TOOLS,
): Promise<ReadonlySet<string>> {
  const { unlistable, error } = await unlistableAgencyTools(specs)
  if (error !== undefined) {
    log.error('AGENCY TOOLS CANNOT BE LISTED — chat cannot reach the CRM until this is fixed', {
      leftOut: unlistable,
      error,
    })
  } else if (unlistable.length > 0) {
    log.error('AGENCY TOOLS LEFT OUT — the model cannot be shown them, so every turn goes without them', {
      leftOut: unlistable,
      listed: specs.length - unlistable.length,
    })
  } else {
    log.info('agency tools: every one can be shown to the model', { tools: specs.length })
  }
  return new Set(unlistable)
}
