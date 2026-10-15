/**
 * The worker's page reader and the conversation ledgers reach every turn
 * (2026-10-13) — pinned by reading the source, as ops-wiring.test.ts pins
 * the ops context, because booting a worker needs a database and a lock.
 *
 * What must hold: `startWorker` builds ONE reader and ONE set of ledgers and
 * hands both to chat and the morning brief alike; `buildTurnRuntime` puts
 * them in the tool context from its deps (never from an argument the model
 * could reach), feeds the ledger from the hooks after every call, registers
 * the failure hook beside the other two, shares one connector watch between
 * the hooks and `canUseTool`, and names the connectors that refused lately in
 * the prompt; and only a person's message — never the brief's prompt, which
 * is ours — is added to the ledger as a turn starts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('the worker builds the reader and the ledgers once', () => {
  const worker = read('worker.ts')
  const body = worker.slice(worker.indexOf('export async function startWorker'), worker.indexOf('async function beginTurn'))

  it('builds each once, in startWorker, before the HTTP server takes a turn', () => {
    expect(body.match(/webReader\(/g)).toHaveLength(1)
    expect(body.match(/new ConversationLedgers\(/g)).toHaveLength(1)
    expect(body.indexOf('webReader(')).toBeLessThan(body.indexOf('createAgentHttpServer('))
    expect(body.indexOf('new ConversationLedgers(')).toBeLessThan(body.indexOf('createAgentHttpServer('))
    // Nowhere else: a reader or a ledger built per turn would forget between turns.
    expect(worker.match(/webReader\(/g)).toHaveLength(1)
    expect(worker.match(/new ConversationLedgers\(/g)).toHaveLength(1)
  })

  it('hands both to chat and to the morning brief', () => {
    const calls = [...body.matchAll(/beginTurn\(\{([\s\S]*?)\}\)/g)].map((m) => m[1] ?? '')
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call).toMatch(/\bweb\b/)
      expect(call).toMatch(/\bconversations\b/)
    }
  })

  it('passes them to buildTurnRuntime’s deps', () => {
    const runtime = worker.slice(worker.indexOf('await buildTurnRuntime('))
    const deps = runtime.slice(0, runtime.indexOf('    {\n      orgId: who.orgId'))
    expect(deps).toMatch(/\bweb,/)
    expect(deps).toMatch(/\bconversations,/)
  })

  it('adds the person’s message as the turn starts — and never the morning brief’s prompt', () => {
    const turn = worker.slice(worker.indexOf('async function beginTurn'))
    const added = turn.indexOf('runtime.conversation?.addPerson(req.text)')
    expect(added).toBeGreaterThan(turn.indexOf("role: 'user'"))
    expect(turn.slice(added - 60, added)).toMatch(/if \(req\.unattended !== true\)/)
    expect(turn.match(/addPerson\(/g)).toHaveLength(1)
  })
})

describe('every turn gets them, from its deps', () => {
  const session = read('runtime/session.ts')
  const runtime = session.slice(session.indexOf('export async function buildTurnRuntime'))

  it('puts the reader and this session’s ledger in the tool context, never from an argument', () => {
    const context = runtime.slice(runtime.indexOf('const toolContext = (): ToolContext => ({'))
    const body = context.slice(0, context.indexOf('createAgencyMcpServer('))
    expect(body).toMatch(/\.\.\.\(deps\.web \? \{ web: deps\.web \} : \{\}\)/)
    expect(body).toMatch(/\.\.\.\(conversation \? \{ conversation \} : \{\}\)/)
    expect(session).not.toMatch(/args\.web\b/)
    expect(session).not.toMatch(/args\.conversation/)
    // The ledger is this chat session's, in this org.
    expect(runtime).toMatch(
      /deps\.conversations\?\.forSession\(\{\s*db: deps\.db,\s*orgId: args\.orgId,\s*sessionId: args\.chatSessionId,?\s*\}\)/,
    )
  })

  it('shares one connector watch between the hooks and canUseTool, and feeds the ledger from the hooks', () => {
    expect(runtime.match(/createConnectorWatch\(/g)).toHaveLength(1)
    const gate = runtime.slice(runtime.indexOf('makeCanUseTool({'), runtime.indexOf('const toolContext'))
    expect(gate).toMatch(/connectors: connectorWatch/)
    const hooks = runtime.slice(runtime.indexOf('const hookDeps = {'), runtime.indexOf('const icpRow'))
    expect(hooks).toMatch(/ledger: conversation/)
    expect(hooks).toMatch(/connectors: connectorWatch/)
  })

  it('registers the failure hook beside the other two, with the same timeout', () => {
    expect(runtime).toMatch(/PreToolUse: \[\{ hooks: \[makePreToolUse\(hookDeps\)\], timeout: HOOK_TIMEOUT_SECONDS \}\]/)
    expect(runtime).toMatch(/PostToolUse: \[\{ hooks: \[makePostToolUse\(hookDeps\)\], timeout: HOOK_TIMEOUT_SECONDS \}\]/)
    expect(runtime).toMatch(
      /PostToolUseFailure: \[\{ hooks: \[makePostToolUseFailure\(hookDeps\)\], timeout: HOOK_TIMEOUT_SECONDS \}\]/,
    )
  })

  it('records a refusal and clears one through the db, for this org', () => {
    const watch = runtime.slice(runtime.indexOf('createConnectorWatch('))
    const call = watch.slice(0, watch.indexOf('})\n'))
    expect(call).toMatch(/connectorsRecordFailure\(deps\.db, \{ orgId: args\.orgId, name, kind/)
    expect(call).toMatch(/connectorsClearFailure\(deps\.db, \{ orgId: args\.orgId, name \}\)/)
  })

  it('names the connectors that refused in the last day in the prompt, and a failed read costs the turn nothing', () => {
    expect(runtime).toMatch(/connectorFailuresSince\(deps\.db, args\.orgId, new Date\(deps\.now\(\)\.getTime\(\) - CONNECTOR_TROUBLE_WINDOW_MS\)\)\.catch\(/)
    const prompt = runtime.slice(runtime.indexOf('systemPrompt: systemPrompt('))
    expect(prompt.slice(0, prompt.indexOf('cwd: deps.cwd'))).toMatch(/\btroubled,\s*\)/)
    expect(session).toMatch(/CONNECTOR_TROUBLE_WINDOW_MS = 24 \* 60 \* 60_000/)
  })
})
