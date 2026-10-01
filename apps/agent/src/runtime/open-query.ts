/**
 * Starting the SDK query, with the connectors handed over the control
 * channel rather than written onto the CLI's argv (§2.3).
 *
 * ## Why not `options.mcpServers`
 *
 * The SDK spawns the Claude Code CLI and turns `options.mcpServers` into
 * `--mcp-config <json>` on ITS command line — every server that is not
 * in-process, its decrypted `authorization`/`x-api-key` header or its stdio
 * credential included, for as long as the turn runs. Anyone who can list
 * processes on the worker host could read it. Read out of the installed
 * `sdk.mjs` (0.3.269), not assumed:
 *
 *  - `query()` splits `options.mcpServers` in two: a server with
 *    `type: 'sdk'` and a live `instance` is kept in the SDK process and its
 *    NAME goes to the CLI in the `initialize` control request, over stdin;
 *    everything else becomes the transport's `mcpServers`, and the transport
 *    pushes `--mcp-config` only when that is non-empty.
 *  - `Query.setMcpServers(servers)` sends `{ subtype: 'mcp_set_servers',
 *    servers }` as a `control_request` through `transport.write`, which is
 *    the child's stdin — the same channel every prompt and approval uses.
 *
 * So `options.mcpServers` carries the in-process `agency` server and nothing
 * else (`buildQueryOptions` types it that way), and the connectors are handed
 * over here, before the user's message is. `test/connector-argv.test.ts`
 * runs the real SDK against a stub CLI that records its argv and stdin, with
 * a control that shows the old shape DID put the credential on argv.
 *
 * ## What the CLI does with the payload
 *
 * Read from the shipped binary (2.1.269) and measured against it:
 * `mcp_set_servers` is AUTHORITATIVE. It replaces the dynamic set, and an
 * in-process server registered at `initialize` but missing from the payload
 * is REMOVED — measured: `{ removed: ['agency'] }`. So `agency` rides in the
 * payload too, as the same instance, which the SDK recognises and leaves
 * connected. The reply waits for every server to connect or fail, bounded by
 * the CLI's own MCP timeout (30 s by default), so the first message of a
 * turn already sees a connector added a moment ago in the UI — §6's promise,
 * kept more strictly than the non-blocking `--mcp-config` startup did.
 *
 * ## The one thing the payload must never carry
 *
 * The SDK types a remote server's config with an optional `tools` list of
 * `{ name, permission_policy }` — "per-tool permission policy carried on
 * mcp_set_servers" — and the CLI turns `always_allow` into an allow rule
 * (`alwaysAllowRules.mcpServerPolicy`), which is answered before
 * `canUseTool` is ever asked. That is a fourth way round the gate, on
 * exactly this channel. Nothing in this product builds one (`BuiltMcpServer`
 * has no such field), and a config that somehow carries the key is refused
 * here rather than handed over.
 */
import {
  query, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/**
 * How long a turn waits for the hand-over before going ahead without it.
 *
 * The CLI bounds each connection itself (MCP_TIMEOUT, 30 s by default), so
 * this is the backstop for a CLI that never answers at all: a turn must
 * always END (chat/turn.ts), and a spinner for the length of the turn's wall
 * clock is not an ending anyone can tell from thinking.
 */
export const HANDOVER_TIMEOUT_MS = 45_000

type HandoverLog = {
  readonly info: (msg: string, fields?: Record<string, unknown>) => void
  readonly warn: (msg: string, fields?: Record<string, unknown>) => void
}

export type HandoverOutcome =
  | { readonly kind: 'done'; readonly failed: readonly string[] }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: string }

/**
 * Hand `servers` to a running query over its control channel.
 *
 * Never throws, and never logs more than server NAMES and an error's name:
 * the CLI's error text for a failed connection can carry the URL, and a URL
 * can carry a credential somebody pasted into the wrong field.
 */
export async function handOverServers(
  session: Pick<Query, 'setMcpServers'>,
  servers: Readonly<Record<string, McpServerConfig>>,
  opts: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number; readonly log: HandoverLog },
): Promise<HandoverOutcome> {
  const payload: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(servers)) {
    if ('tools' in server) {
      opts.log.warn('connector refused: its config carries a per-tool permission policy', { connector: name })
      continue
    }
    payload[name] = server
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    if (opts.signal?.aborted) return { kind: 'aborted' }
    const outcome = await Promise.race<HandoverOutcome>([
      session.setMcpServers(payload).then((result) => ({ kind: 'done', failed: Object.keys(result.errors) })),
      new Promise<HandoverOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), opts.timeoutMs ?? HANDOVER_TIMEOUT_MS)
      }),
      new Promise<HandoverOutcome>((resolve) => {
        onAbort = () => resolve({ kind: 'aborted' })
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    if (outcome.kind === 'done' && outcome.failed.length > 0) {
      opts.log.warn('connectors did not connect this turn', { connectors: outcome.failed })
    } else if (outcome.kind === 'timeout') {
      opts.log.warn('connectors were still connecting when the turn went ahead', {
        connectors: Object.keys(payload),
      })
    }
    return outcome
  } catch (err) {
    const error = err instanceof Error ? err.name : 'UnknownError'
    opts.log.warn('connectors could not be handed to the agent runtime', { error })
    return { kind: 'error', error }
  } finally {
    clearTimeout(timer)
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * The user's message, exactly as the SDK writes a string prompt.
 */
function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

/**
 * One turn's query: the connectors first, then the prompt.
 *
 * With nothing to hand over the prompt is a string, exactly as before. With
 * connectors the prompt is a one-message stream that yields only once the
 * hand-over has settled — connected, failed, timed out or aborted — because
 * a message ahead of `mcp_set_servers` on stdin would race it: nothing makes
 * the CLI finish connecting before it builds that message's first model
 * request, and a connector that lost the race would be missing from the
 * message it was added for. The SDK closes stdin after the first
 * result for a stream exactly as it does for a string (it has a gate and
 * hooks to answer), so the turn ends the same way either way.
 *
 * `run` is the SDK's `query` outside tests.
 */
export function openQuery(
  args: {
    readonly prompt: string
    readonly options: Options
    /** Handed over before the prompt; empty or absent means there is nothing to hand over. */
    readonly mcpServers?: Readonly<Record<string, McpServerConfig>> | undefined
    readonly log: HandoverLog
    readonly timeoutMs?: number
  },
  run: typeof query = query,
): AsyncIterable<SDKMessage> {
  const servers = args.mcpServers ?? {}
  if (Object.keys(servers).length === 0) return run({ prompt: args.prompt, options: args.options })

  const signal = args.options.abortController?.signal
  let handedOver!: () => void
  const settled = new Promise<void>((resolve) => {
    handedOver = resolve
  })
  const prompt = async function* (): AsyncGenerator<SDKUserMessage, void> {
    await settled
    if (signal?.aborted) return
    yield userMessage(args.prompt)
  }

  const session = run({ prompt: prompt(), options: args.options })
  void handOverServers(session, servers, {
    signal,
    log: args.log,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  }).finally(handedOver)
  return session
}
