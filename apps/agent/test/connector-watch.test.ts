/**
 * A connector that refuses, noticed in the turn it refuses (2026-10-13).
 *
 * The shapes below are the ones read from the worker's own CLI transcripts
 * on the operator's Mac: jina's in-band `Error: Search failed … Unauthorized`
 * and tavily's `{"error":…,"status":429}`, which the CLI reports as
 * SUCCESSES (PostToolUse), and firecrawl's flagged "keyless access is
 * unavailable", which it reports as a failure (PostToolUseFailure). For each:
 * the model is told in our words, never the server's; the next call to that
 * server in the turn is refused by `canUseTool`; and the connector row
 * records it once. And the hooks never throw, never wait on the database, and
 * never mark the agency's own tools.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ChatEventBody } from '@agency/core'
import type { ApprovalRow } from '@agency/db'
import { textShowsEmail } from '@agency/core'
import { ConversationLedgers } from '../src/chat/ledger.js'
import { makeCanUseTool, type GateDeps } from '../src/gate/can-use-tool.js'
import {
  connectorRefusalSentence, connectorServerOf, createConnectorWatch, type ConnectorWatch,
} from '../src/gate/connector-watch.js'
import { createLedger } from '../src/gate/ledger.js'
import { makePostToolUse, makePostToolUseFailure, type HookDeps } from '../src/gate/pre-tool-use.js'
import type { AgencyDb } from '@agency/db'

const JINA_IN_BAND = 'Error: Search failed for query "acme dental pune founder": Unauthorized'
const FIRECRAWL_FLAGGED =
  'Anonymous keyless access is unavailable for this request. Fix: Create an API key at https://firecrawl.dev/k/abc123 ' +
  'Set the header: Authorization: Bearer fc-…'
const TAVILY_IN_BAND =
  '{"error":"Search failed","status":429,"detail":{"error":"Your request has been blocked due to excessive requests. ' +
  'Please verify you are using production API keys."}}'

const mcp = (text: string) => [{ type: 'text', text }]

function watch() {
  const record = vi.fn(async (_server: string, _kind: string) => true)
  const clear = vi.fn(async (_server: string) => true)
  const warn = vi.fn()
  const w = createConnectorWatch({ record, clear, log: { warn } })
  return { w, record, clear, warn }
}

function hookDeps(connectors: ConnectorWatch, over: Partial<HookDeps> = {}): HookDeps {
  return { audit: async () => {}, log: { error: () => {} }, disabledTools: new Set(), connectors, ...over }
}

const post = (toolName: string, response: unknown, input: unknown = { query: 'q' }) => ({
  hook_event_name: 'PostToolUse',
  tool_name: toolName,
  tool_input: input,
  tool_response: response,
  tool_use_id: 'toolu_1',
  session_id: 'sdk-1',
})

const failure = (toolName: string, error: string, over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name: toolName,
  tool_input: { url: 'https://acme.in' },
  tool_use_id: 'toolu_2',
  error,
  session_id: 'sdk-1',
  ...over,
})

function gate(connectors: Pick<ConnectorWatch, 'refused'>, over: Partial<GateDeps> = {}) {
  const audited: Array<[string, Record<string, unknown>]> = []
  const ensureApproval = vi.fn(async () => ({ id: 'a-1', status: 'pending' }) as unknown as ApprovalRow)
  const deps: GateDeps = {
    orgId: 'org-1',
    chatSessionId: 'session-1',
    turnId: 'turn-1',
    ttlMs: 60_000,
    turnDeadline: new Date(Date.now() + 120_000),
    now: () => new Date(),
    parseToolInput: (_n, input) => ({ ok: true, value: input }),
    ensureApproval,
    waiter: { healthy: true, await: async () => ({ status: 'denied' as const, decidedBy: 'u-1', reason: null }) },
    ledger: createLedger(),
    disabledTools: new Set(),
    audit: async (action, detail) => {
      audited.push([action, detail])
    },
    emit: (_e: ChatEventBody) => {},
    markGated: () => {},
    halted: () => false,
    log: { warn: () => {}, error: () => {} },
    connectors,
    ...over,
  }
  return { canUseTool: makeCanUseTool(deps), audited, ensureApproval }
}

const options = (toolUseID = 'toolu_9') =>
  ({ signal: new AbortController().signal, toolUseID, requestId: 'r' }) as unknown as Parameters<
    ReturnType<typeof makeCanUseTool>
  >[2]

describe('the server a tool belongs to', () => {
  it('is the part between mcp__ and the next __, and never the agency’s own', () => {
    expect(connectorServerOf('mcp__jina__search_web')).toBe('jina')
    expect(connectorServerOf('mcp__agency__get_company')).toBeNull()
    expect(connectorServerOf('Agent')).toBeNull()
    expect(connectorServerOf('mcp____x')).toBeNull()
    expect(connectorServerOf(undefined)).toBeNull()
  })
})

describe('a refusal in band (PostToolUse)', () => {
  it('jina’s "Unauthorized": the model is told, the next call is refused, the row records it once', async () => {
    const { w, record, clear } = watch()
    const out = await makePostToolUse(hookDeps(w))(post('mcp__jina__search_web', mcp(JINA_IN_BAND)))
    expect(out['hookSpecificOutput']).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: connectorRefusalSentence('jina', 'auth'),
    })
    expect((out['hookSpecificOutput'] as { additionalContext: string }).additionalContext).toMatch(
      /^jina refused that call — its key is missing, wrong or not accepted\. It will refuse again this turn: do not call it again; tell the person it needs attention in Settings → Connectors, and use read_page or another connector instead\.$/,
    )
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('jina', 'auth')
    expect(clear).not.toHaveBeenCalled()

    // A second refusal in the same turn writes nothing more.
    await makePostToolUse(hookDeps(w))(post('mcp__jina__read_url', mcp('HTTP 401: Unauthorized')))
    expect(record).toHaveBeenCalledTimes(1)

    // The gate refuses the next call to that server at once — even one an owner
    // let run without a card — and audits it as an immediate refusal.
    const { canUseTool, audited, ensureApproval } = gate(w, { readsWithoutCard: new Set(['mcp__jina__*']) })
    const next = await canUseTool('mcp__jina__search_web', { query: 'another' }, options())
    expect(next).toEqual({ behavior: 'deny', message: connectorRefusalSentence('jina', 'auth') })
    expect(ensureApproval).not.toHaveBeenCalled()
    expect(audited).toEqual([
      ['agent.tool_refused', { toolName: 'mcp__jina__search_web', toolUseId: 'toolu_9', risk: 'high', rule: 'connector_refused' }],
    ])
    // Another server is untouched by jina's refusal.
    const other = await canUseTool('mcp__exa__web_search_exa', { query: 'x' }, options('toolu_10'))
    expect(other).not.toEqual({ behavior: 'deny', message: expect.stringContaining('refused that call') })
  })

  it('tavily’s 429 is a quota, worded as one', async () => {
    const { w, record } = watch()
    const out = await makePostToolUse(hookDeps(w))(post('mcp__tavily__tavily_search', mcp(TAVILY_IN_BAND)))
    expect((out['hookSpecificOutput'] as { additionalContext: string }).additionalContext).toBe(
      connectorRefusalSentence('tavily', 'quota'),
    )
    expect(connectorRefusalSentence('tavily', 'quota')).toContain('it is rate-limited or out of quota')
    expect(record).toHaveBeenCalledWith('tavily', 'quota')
    expect(w.refused('tavily')).toBe('quota')
  })

  it('reads a long article that mentions 401 and "unauthorized" as a result, and clears the row once', async () => {
    const { w, record, clear } = watch()
    const article =
      'How to fix a 401 Unauthorized error in your web app. '.repeat(10) +
      'Rate limit headers explained, with 429 Too Many Requests examples. '.repeat(30)
    const hook = makePostToolUse(hookDeps(w))
    expect(await hook(post('mcp__exa__web_search_exa', mcp(article)))).toEqual({})
    expect(await hook(post('mcp__exa__web_search_exa', mcp('Acme Dental, Pune')))).toEqual({})
    expect(record).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith('exa')
    expect(w.refused('exa')).toBeNull()
  })

  it('never marks the agency’s own tools, whatever they answer', async () => {
    const { w, record, clear } = watch()
    const out = await makePostToolUse(hookDeps(w))(post('mcp__agency__get_company', mcp('Error: Unauthorized')))
    expect(out).toEqual({})
    expect(record).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('feeds the conversation’s ledger for the main thread and helpers, with the call’s own input stripped', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) }
    const ledger = new ConversationLedgers().forSession({ db: db as unknown as AgencyDb, orgId: 'o', sessionId: 's' })
    const hook = makePostToolUse(hookDeps(watch().w, { ledger }))
    await hook({ ...post('mcp__exa__web_search_exa', mcp('Acme Dental — info@acmedental.in')), agent_id: 'sub-1' })
    await hook(post('mcp__exa__web_search_exa', mcp('No results for akash@acmedental.in'), { query: 'akash@acmedental.in' }))
    expect(await ledger.find((t) => textShowsEmail(t, 'info@acmedental.in'))).toEqual([
      { kind: 'tool', tool: 'mcp__exa__web_search_exa' },
    ])
    expect(await ledger.find((t) => textShowsEmail(t, 'akash@acmedental.in'))).toEqual([])
  })

  it('adds an in-band refusal to nothing — it shows nothing true, as a flagged error does not', async () => {
    const ledger = { addPerson: vi.fn(), addToolResult: vi.fn(), find: vi.fn() }
    const refusal = 'Error: Search failed: Unauthorized. Get a key at https://jina.ai or mail billing@jina.ai'
    const hook = makePostToolUse(hookDeps(watch().w, { ledger }))
    await hook(post('mcp__jina__search_web', mcp(refusal)))
    expect(ledger.addToolResult).not.toHaveBeenCalled()
    // Without a watch the answer is still read as a refusal, and still kept out.
    await makePostToolUse({ audit: async () => {}, log: { error: () => {} }, disabledTools: new Set(), ledger })(
      post('mcp__jina__search_web', mcp(refusal)),
    )
    expect(ledger.addToolResult).not.toHaveBeenCalled()
    // A clean answer from the same server is added.
    await hook(post('mcp__jina__search_web', mcp('Acme Dental, Pune')))
    expect(ledger.addToolResult).toHaveBeenCalledTimes(1)
  })
})

describe('a flagged refusal (PostToolUseFailure)', () => {
  it('firecrawl’s keyless refusal: told in our words, refused next, recorded once', async () => {
    const { w, record } = watch()
    const out = await makePostToolUseFailure(hookDeps(w))(failure('mcp__firecrawl__firecrawl_scrape', FIRECRAWL_FLAGGED))
    expect(out['hookSpecificOutput']).toEqual({
      hookEventName: 'PostToolUseFailure',
      additionalContext: connectorRefusalSentence('firecrawl', 'auth'),
    })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('firecrawl', 'auth')
    const { canUseTool } = gate(w)
    expect(await canUseTool('mcp__firecrawl__firecrawl_search', { query: 'x' }, options())).toMatchObject({
      behavior: 'deny',
      message: connectorRefusalSentence('firecrawl', 'auth'),
    })
  })

  it('jina’s flagged "HTTP 401" too', async () => {
    const { w, record } = watch()
    const out = await makePostToolUseFailure(hookDeps(w))(failure('mcp__jina__read_url', 'HTTP 401: Unauthorized'))
    expect(out['hookSpecificOutput']).toMatchObject({ hookEventName: 'PostToolUseFailure' })
    expect(record).toHaveBeenCalledWith('jina', 'auth')
  })

  it('leaves a page the connector could not fetch, an interrupted call and the agency’s own failures alone', async () => {
    const { w, record } = watch()
    const hook = makePostToolUseFailure(hookDeps(w))
    expect(await hook(failure('mcp__firecrawl__firecrawl_scrape', 'Failed to scrape https://acme.in: 403 Forbidden'))).toEqual({})
    expect(await hook(failure('mcp__firecrawl__firecrawl_scrape', FIRECRAWL_FLAGGED, { is_interrupt: true }))).toEqual({})
    expect(await hook(failure('mcp__agency__read_page', 'invalid api key'))).toEqual({})
    expect(await hook(post('mcp__firecrawl__firecrawl_scrape', mcp(FIRECRAWL_FLAGGED)))).toEqual({})
    expect(record).not.toHaveBeenCalled()
  })

  it('adds nothing to the ledger: an error shows nothing true', async () => {
    const ledger = { addPerson: vi.fn(), addToolResult: vi.fn(), find: vi.fn() }
    await makePostToolUseFailure(hookDeps(watch().w, { ledger }))(failure('mcp__exa__web_search_exa', 'info@acme.in failed'))
    expect(ledger.addToolResult).not.toHaveBeenCalled()
  })
})

describe('what the model is told', () => {
  it('never carries the server’s own words — no link, no query, no header', async () => {
    const said: string[] = []
    for (const [hook, input] of [
      [makePostToolUse, post('mcp__jina__search_web', mcp(JINA_IN_BAND))],
      [makePostToolUse, post('mcp__tavily__tavily_search', mcp(TAVILY_IN_BAND))],
      [makePostToolUseFailure, failure('mcp__firecrawl__firecrawl_scrape', FIRECRAWL_FLAGGED)],
    ] as const) {
      const out = await hook(hookDeps(watch().w))(input)
      said.push(JSON.stringify(out))
    }
    const all = said.join('\n')
    for (const leak of ['acme dental pune founder', 'firecrawl.dev', 'Bearer', 'Anonymous', 'excessive', 'production API keys', 'Unauthorized']) {
      expect(all).not.toContain(leak)
    }
  })
})

describe('the watch’s writes', () => {
  it('never hold a hook up — a write that never answers costs the hook nothing', async () => {
    const record = vi.fn(() => new Promise<boolean>(() => {}))
    const w = createConnectorWatch({ record, clear: async () => true, log: { warn: () => {} } })
    const out = await makePostToolUse(hookDeps(w))(post('mcp__jina__search_web', mcp(JINA_IN_BAND)))
    expect(out['hookSpecificOutput']).toBeDefined()
  })

  it('log a write that failed by its class only', async () => {
    const warn = vi.fn()
    const w = createConnectorWatch({
      record: async () => {
        throw new TypeError('relation "connectors" … value jina-secret-xyz')
      },
      clear: async () => true,
      log: { warn },
    })
    w.fail('jina', 'auth')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'TypeError' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
  })

  it('run in the order they were asked for, clear at most once, and never clear a server that refused this turn', async () => {
    const order: string[] = []
    const w = createConnectorWatch({
      record: async (s) => {
        await new Promise((r) => setTimeout(r, 5))
        order.push(`record ${s}`)
      },
      clear: async (s) => {
        await new Promise((r) => setTimeout(r, 20))
        order.push(`clear ${s}`)
      },
      log: { warn: () => {} },
    })
    w.ok('exa')
    w.ok('exa')
    w.fail('exa', 'quota')
    w.ok('exa')
    w.fail('jina', 'auth')
    w.ok('jina')
    await vi.waitFor(() => expect(order).toHaveLength(3))
    expect(order).toEqual(['clear exa', 'record exa', 'record jina'])
  })
})

describe('the hooks never throw', () => {
  const broken = (): HookDeps => ({
    audit: () => {
      throw new Error('audit down')
    },
    log: {
      error: () => {
        throw new Error('log down')
      },
    },
    disabledTools: new Set(),
    ledger: {
      addPerson: () => {},
      addToolResult: () => {
        throw new Error('ledger down')
      },
      find: async () => [],
    },
    connectors: {
      refused: () => null,
      fail: () => {
        throw new Error('watch down')
      },
      ok: () => {
        throw new Error('watch down')
      },
    },
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 7],
    ['a nameless event', { hook_event_name: 'PostToolUse' }],
    ['a name that is not a string', { hook_event_name: 'PostToolUse', tool_name: 5, tool_response: {} }],
    ['a refusal, with everything broken', post('mcp__jina__search_web', mcp(JINA_IN_BAND))],
    ['a clean answer, with everything broken', post('mcp__exa__web_search_exa', mcp('fine'))],
  ])('PostToolUse settles on %s', async (_label, input) => {
    await expect(makePostToolUse(broken())(input)).resolves.toBeTypeOf('object')
  })

  it.each([
    ['nothing', undefined],
    ['an error that is not a string', { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__jina__x', error: { text: 'HTTP 401' } }],
    ['a refusal, with everything broken', failure('mcp__firecrawl__firecrawl_scrape', FIRECRAWL_FLAGGED)],
  ])('PostToolUseFailure settles on %s', async (_label, input) => {
    await expect(makePostToolUseFailure(broken())(input)).resolves.toBeTypeOf('object')
  })

  it('still tells the model when the audit write throws', async () => {
    const { w } = watch()
    const out = await makePostToolUse(
      hookDeps(w, {
        audit: () => {
          throw new Error('audit down')
        },
      }),
    )(post('mcp__jina__search_web', mcp(JINA_IN_BAND)))
    expect(out['hookSpecificOutput']).toMatchObject({ additionalContext: connectorRefusalSentence('jina', 'auth') })
  })
})
