/**
 * A connector's credential never reaches the `claude` process's argv (§2.3).
 *
 * The SDK writes every server in `options.mcpServers` that is not
 * in-process onto the CLI's command line as `--mcp-config <json>` — the
 * decrypted `authorization` header and the stdio credential included — for
 * as long as a turn runs, where anyone who can list processes on the worker
 * host can read it. The turn and Test connection now hand connectors over
 * the control channel (`Query.setMcpServers`, on stdin) instead.
 *
 * Proved against the REAL SDK, not a mock of it: `pathToClaudeCodeExecutable`
 * points at a stub CLI that writes down the argv it was started with and
 * every line it reads on stdin, answers the control requests, and ends the
 * turn on the user's message. So what is asserted is what the SDK actually
 * put on a command line. The first test is the control: the same SDK, the
 * same stub and the shape this code used to build DO put the credential on
 * argv — without it, "the secret is not in argv" could pass because the stub
 * recorded nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '@agency/core'
import {
  createChatSession, createConnector, putSecret, schema, setConnectorEnabled, type AgencyDb, type ConnectorRow,
} from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import { buildTurnRuntime, createHalt } from '../src/runtime/session.js'
import { buildConnector } from '../src/runtime/connectors.js'
import { childEnv } from '../src/runtime/options.js'
import { probeConnector } from '../src/runtime/probe.js'
import { startTurn } from '../src/chat/turn.js'

const KEY = randomBytes(32)
/** Shaped like the real thing so nothing downstream treats it as a placeholder. */
const HTTP_TOKEN = 'sk-apollo-live-4c1e9b7a20d3f86e'
const STDIO_TOKEN = 'ghp_files0123456789abcdefghijklmnopqrstuv'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/**
 * The stub CLI. Started by the SDK as `node stub.mjs <argv…>`, with the
 * environment the worker builds (`childEnv`) — which is why the place it
 * writes to is baked into its source rather than read from a variable.
 */
function stubSource(dir: string): string {
  return `
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const dir = ${JSON.stringify(dir)}
writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)))
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const ok = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const dynamic = {}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  appendFileSync(dir + '/stdin.jsonl', line + '\\n')
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'control_request') {
    const r = m.request
    if (r.subtype === 'mcp_set_servers') {
      Object.assign(dynamic, r.servers)
      return ok(m.request_id, { added: Object.keys(r.servers), removed: [], errors: {} })
    }
    if (r.subtype === 'mcp_status') {
      const names = Object.keys(dynamic).filter((n) => dynamic[n].type !== 'sdk')
      return ok(m.request_id, { mcpServers: names.map((name) => ({ name, status: 'connected', tools: [{ name: 'echo', description: 'echo' }] })) })
    }
    return ok(m.request_id, {})
  }
  if (m.type === 'user') {
    send({
      type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'stub-session',
      total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1,
      usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000000',
    })
  }
})
rl.on('close', () => process.exit(0))
`
}

describe('connector credentials and the CLI’s argv', () => {
  let root: string
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let userId: string
  let http: ConnectorRow
  let stdio: ConnectorRow
  let run = 0
  let dir: string
  let stub: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agency-argv-'))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    dir = join(root, `run-${(run += 1)}`)
    mkdirSync(dir)
    stub = join(dir, 'claude-stub.mjs')
    writeFileSync(stub, stubSource(dir))

    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id }))[0]!.id
    userId = (
      await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    )[0]!.id

    const httpSecret = await putSecret(db, { orgId, label: 'Apollo', plaintext: HTTP_TOKEN }, KEY)
    http = await createConnector(db, {
      orgId, name: 'apollo', kind: 'http', config: { url: 'https://mcp.apollo.example/v1', headers: {} }, secretRef: httpSecret,
    })
    await setConnectorEnabled(db, orgId, http.id, true)
    const stdioSecret = await putSecret(db, { orgId, label: 'Files', plaintext: STDIO_TOKEN }, KEY)
    stdio = await createConnector(db, {
      orgId, name: 'files', kind: 'stdio', config: { command: 'npx', args: ['@acme/mcp-files@1.2.3'], env: {} }, secretRef: stdioSecret,
    })
    await setConnectorEnabled(db, orgId, stdio.id, true)
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const argv = (): string[] => JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[]
  const stdinLines = (): Record<string, unknown>[] =>
    existsSync(join(dir, 'stdin.jsonl'))
      ? readFileSync(join(dir, 'stdin.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      : []
  const isSetServers = (l: Record<string, unknown>) =>
    l['type'] === 'control_request' && (l['request'] as { subtype?: string }).subtype === 'mcp_set_servers'

  /** The shape a turn used to build: connectors in `options.mcpServers`. */
  it('CONTROL: a connector in options.mcpServers is written onto the CLI’s argv, credential and all', async () => {
    const [h, s] = await Promise.all([buildConnector(db, http, KEY, silent), buildConnector(db, stdio, KEY, silent)])
    if ('why' in h || 'why' in s) throw new Error('could not build the connectors')
    const abort = new AbortController()
    const session = query({
      prompt: 'hello',
      options: {
        tools: [], allowedTools: [], settingSources: [], strictMcpConfig: true, permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'no' }),
        mcpServers: { apollo: h.server, files: s.server } as never,
        abortController: abort, cwd: dir, env: childEnv({ kind: 'api_key', apiKey: 'sk-ant-test' }),
        pathToClaudeCodeExecutable: stub,
      },
    })
    for await (const message of session) void message
    const line = argv().join(' ')
    expect(argv()).toContain('--mcp-config')
    expect(line).toContain(`Bearer ${HTTP_TOKEN}`)
    expect(line).toContain(STDIO_TOKEN)
  })

  const runtimeFor = async () =>
    buildTurnRuntime(
      {
        db, log: silent, halt: createHalt(silent), credential: { kind: 'api_key', apiKey: 'sk-ant-test' },
        claudeCodePath: stub, maxTurns: 1, maxBudgetUsd: 1, secretsKey: KEY, skills: { settingSources: [] },
        approvalTtlMs: 60_000, approvalPollMs: 50, turnTimeoutMs: 60_000, cwd: dir, now: () => new Date(),
      },
      {
        orgId, orgName: 'Agency', chatSessionId: (await createChatSession(db, { orgId, userId })).id,
        principal: { id: userId, orgId, role: 'owner' }, resume: null, emit: () => {},
      },
    )

  it('a turn’s options carry the in-process server only; the connectors ride in the hand-over', async () => {
    const runtime = await runtimeFor()
    expect(Object.keys(runtime.options.mcpServers ?? {})).toEqual(['agency'])
    expect(Object.keys(runtime.mcpServers).sort()).toEqual(['agency', 'apollo', 'files'])
    // The SAME instance in both: the hand-over replaces the dynamic set, and
    // the SDK keeps an in-process server connected only when it recognises it.
    expect(runtime.mcpServers['agency']).toBe(runtime.options.mcpServers?.['agency'])

    // With no connector there is nothing to hand over, and a turn runs as it always did.
    await setConnectorEnabled(db, orgId, http.id, false)
    await setConnectorEnabled(db, orgId, stdio.id, false)
    expect((await runtimeFor()).mcpServers).toEqual({})
  })

  it('a turn puts no connector credential on argv, and hands the connectors over stdin before the prompt', async () => {
    const runtime = await runtimeFor()
    const turn = startTurn(
      {
        orgId, sessionId: 's', userId, turnId: runtime.turnId,
        claim: async () => true, release: async () => {}, sessionCostSoFar: async () => 0, sessionBudgetUsd: 100,
        persist: async () => {}, setSdkSessionId: async () => {}, cancelPendingApprovals: async () => [],
        usd: (n) => n.toFixed(6), now: () => new Date(), log: silent,
      },
      { text: 'hello', options: runtime.options, mcpServers: runtime.mcpServers, abort: runtime.abort, timeoutMs: 30_000 },
    )
    const events: ChatEvent[] = []
    for await (const e of turn.events()) events.push(e)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_finished', reason: 'success' })

    // Nothing about a connector on the command line: no --mcp-config at all,
    // since the one server left in the option is in-process.
    const line = argv().join(' ')
    expect(argv()).not.toContain('--mcp-config')
    expect(line).not.toContain(HTTP_TOKEN)
    expect(line).not.toContain(STDIO_TOKEN)
    expect(line).not.toContain('mcp.apollo.example')

    // …and everything about them on stdin, in one control request that comes
    // before the user's message.
    const lines = stdinLines()
    const handover = lines.findIndex(isSetServers)
    const prompt = lines.findIndex((l) => l['type'] === 'user')
    expect(handover).toBeGreaterThan(-1)
    expect(prompt).toBeGreaterThan(handover)
    const servers = (lines[handover]!['request'] as { servers: Record<string, Record<string, unknown>> }).servers
    expect(Object.keys(servers).sort()).toEqual(['agency', 'apollo', 'files'])
    expect(servers['apollo']).toMatchObject({ type: 'http', headers: { authorization: `Bearer ${HTTP_TOKEN}` } })
    expect(servers['files']).toMatchObject({ type: 'stdio', env: { MCP_SECRET: STDIO_TOKEN } })
    // The in-process server goes by name, as the SDK sends it — it has to be
    // in the payload, which REPLACES the dynamic set, or the CLI drops it.
    expect(servers['agency']).toMatchObject({ type: 'sdk', name: 'agency' })
  }, 60_000)

  it('Test connection puts no credential on argv either', async () => {
    const result = await probeConnector(db, http, KEY, { kind: 'api_key', apiKey: 'sk-ant-test' }, dir, silent, stub)
    expect(result).toMatchObject({ ok: true, tools: [{ name: 'echo' }] })
    const line = argv().join(' ')
    expect(argv()).not.toContain('--mcp-config')
    expect(line).not.toContain(HTTP_TOKEN)
    const handover = stdinLines().find(isSetServers)
    expect((handover?.['request'] as { servers: Record<string, unknown> }).servers).toEqual({
      apollo: { type: 'http', url: 'https://mcp.apollo.example/v1', headers: { authorization: `Bearer ${HTTP_TOKEN}` } },
    })
  }, 60_000)
})
