/**
 * The connectors are handed over BEFORE the prompt (`runtime/open-query.ts`).
 *
 * `connector-argv.test.ts` proves the credential leaves argv, against the
 * real SDK. This proves the order and the edges with an injected `query`: the
 * user's message is not handed to the SDK until `setMcpServers` has settled,
 * because a message ahead of the hand-over on stdin would race it — and a
 * connector added a moment ago in the UI could be missing from the very
 * message it was added for (§6).
 */
import { describe, it, expect, vi } from 'vitest'
import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { HANDOVER_TIMEOUT_MS, handOverServers, openQuery } from '../src/runtime/open-query.js'

const SERVERS: Record<string, McpServerConfig> = {
  apollo: { type: 'http', url: 'https://mcp.apollo.example/v1', headers: { authorization: 'Bearer sk-apollo-live-1' } },
  agency: { type: 'sdk', name: 'agency', instance: {} as never },
}

function capturingLog() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
  return {
    lines,
    info: (msg: string, fields?: Record<string, unknown>) => lines.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
  }
}

/** A stand-in for the SDK's `query`: records what it was handed and lets the test answer `setMcpServers`. */
function fakeQuery() {
  let answer!: (result: { added: string[]; removed: string[]; errors: Record<string, string> }) => void
  let fail!: (err: Error) => void
  const handedOver = new Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>((resolve, reject) => {
    answer = resolve
    fail = reject
  })
  const calls: { prompt: unknown; options: unknown }[] = []
  const setMcpServers = vi.fn(async (_servers: Record<string, McpServerConfig>) => handedOver)
  const run = ((args: { prompt: unknown; options: unknown }) => {
    calls.push(args)
    return { setMcpServers, async *[Symbol.asyncIterator]() {} }
  }) as never
  return { run, calls, setMcpServers, answer, fail }
}

const first = async (prompt: unknown): Promise<IteratorResult<SDKUserMessage>> =>
  (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()

const tick = () => new Promise<void>((r) => setTimeout(r, 10))

describe('openQuery', () => {
  it('hands the connectors over, and only then the user’s message', async () => {
    const q = fakeQuery()
    const log = capturingLog()
    openQuery({ prompt: 'who should we call?', options: { abortController: new AbortController() }, mcpServers: SERVERS, log }, q.run)

    expect(q.setMcpServers).toHaveBeenCalledTimes(1)
    expect(q.setMcpServers.mock.calls[0]![0]).toEqual(SERVERS)
    const pulled = first(q.calls[0]!.prompt)
    let yielded = false
    void pulled.then(() => {
      yielded = true
    })
    await tick()
    // The SDK is asking for the message; it does not get one yet.
    expect(yielded).toBe(false)

    q.answer({ added: ['apollo'], removed: [], errors: {} })
    const message = await pulled
    expect(message.done).toBe(false)
    expect(message.value).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'who should we call?' }] },
      parent_tool_use_id: null,
    })
    expect(log.lines).toEqual([])
  })

  it('with nothing to hand over, passes the prompt as a string and asks nothing', async () => {
    const q = fakeQuery()
    openQuery({ prompt: 'hello', options: {}, mcpServers: {}, log: capturingLog() }, q.run)
    openQuery({ prompt: 'hello', options: {}, log: capturingLog() }, q.run)
    expect(q.calls.map((c) => c.prompt)).toEqual(['hello', 'hello'])
    expect(q.setMcpServers).not.toHaveBeenCalled()
  })

  it('goes ahead when a connector fails, and logs its NAME — never what the CLI said about it', async () => {
    const q = fakeQuery()
    const log = capturingLog()
    openQuery({ prompt: 'hi', options: {}, mcpServers: SERVERS, log }, q.run)
    q.answer({ added: ['apollo'], removed: [], errors: { apollo: 'connect ECONNREFUSED https://mcp.apollo.example/v1?token=sk-leak' } })
    expect((await first(q.calls[0]!.prompt)).done).toBe(false)
    expect(log.lines).toEqual([{ level: 'warn', msg: 'connectors did not connect this turn', fields: { connectors: ['apollo'] } }])
    expect(JSON.stringify(log.lines)).not.toContain('sk-leak')
  })

  it('goes ahead when the hand-over itself fails, naming only the error class', async () => {
    const q = fakeQuery()
    const log = capturingLog()
    openQuery({ prompt: 'hi', options: {}, mcpServers: SERVERS, log }, q.run)
    q.fail(new TypeError('Cannot write to terminated process: Bearer sk-apollo-live-1'))
    expect((await first(q.calls[0]!.prompt)).done).toBe(false)
    expect(log.lines).toEqual([
      { level: 'warn', msg: 'connectors could not be handed to the agent runtime', fields: { error: 'TypeError' } },
    ])
  })

  /** A turn must always end: a CLI that never answers costs the turn a wait, not the turn. */
  it('goes ahead without the answer once the hand-over has waited long enough', async () => {
    const q = fakeQuery()
    const log = capturingLog()
    openQuery({ prompt: 'hi', options: {}, mcpServers: SERVERS, log, timeoutMs: 20 }, q.run)
    expect((await first(q.calls[0]!.prompt)).done).toBe(false)
    expect(log.lines[0]).toMatchObject({ level: 'warn', msg: 'connectors were still connecting when the turn went ahead' })
    expect(HANDOVER_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('sends no message at all once the turn is stopped during the hand-over', async () => {
    const q = fakeQuery()
    const abort = new AbortController()
    openQuery({ prompt: 'hi', options: { abortController: abort }, mcpServers: SERVERS, log: capturingLog() }, q.run)
    const pulled = first(q.calls[0]!.prompt)
    abort.abort()
    expect((await pulled).done).toBe(true)
  })
})

describe('handOverServers', () => {
  /**
   * The SDK types a remote server's `tools` as per-tool permission policies
   * "carried on mcp_set_servers", and the CLI turns `always_allow` into an
   * allow rule answered before `canUseTool`. Nothing here builds one; a
   * config that carries the key anyway is not handed over.
   */
  it('refuses a server whose config carries a per-tool permission policy', async () => {
    const q = fakeQuery()
    const log = capturingLog()
    const done = handOverServers(
      q as never,
      {
        ...SERVERS,
        zapier: { type: 'http', url: 'https://mcp.zapier.example', tools: [{ name: 'send_email', permission_policy: 'always_allow' }] },
      },
      { log },
    )
    q.answer({ added: ['apollo'], removed: [], errors: {} })
    expect(await done).toEqual({ kind: 'done', failed: [] })
    expect(Object.keys(q.setMcpServers.mock.calls[0]![0]).sort()).toEqual(['agency', 'apollo'])
    expect(log.lines).toEqual([
      { level: 'warn', msg: 'connector refused: its config carries a per-tool permission policy', fields: { connector: 'zapier' } },
    ])
  })

  it('answers an abort that came first without asking the CLI', async () => {
    const q = fakeQuery()
    const abort = new AbortController()
    abort.abort()
    expect(await handOverServers(q as never, SERVERS, { signal: abort.signal, log: capturingLog() })).toEqual({ kind: 'aborted' })
    expect(q.setMcpServers).not.toHaveBeenCalled()
  })
})
