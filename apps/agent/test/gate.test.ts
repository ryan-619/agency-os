/**
 * The approval gate.
 *
 * There is no API key in this environment and the SDK ships no mock transport,
 * so the model's half cannot be exercised. That turns out not to matter much
 * here: `canUseTool` is a function from (toolName, input, options) to a
 * permission result, and every property worth asserting about it is a property
 * of that function.
 *
 * The contract, in one line: **it always settles, and never with `null`.** The
 * SDK's own words are that a null sends no control_response and "the tool
 * stays blocked indefinitely — permission prompts have no park deadline". A
 * hang is the worst outcome in this phase because it is indistinguishable from
 * the model thinking, so the first tests below are about that rather than
 * about any particular decision.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChatEventBody } from '@agency/core'
import { connectorToolsEveryTool, type ApprovalRow } from '@agency/db'
import { makeCanUseTool, type GateDeps } from '../src/gate/can-use-tool.js'
import { makePreToolUse, makePostToolUse, type HookDeps } from '../src/gate/pre-tool-use.js'
import { createLedger, fingerprint } from '../src/gate/ledger.js'
import { createApprovalWaiter, abortableSleep, type Decision } from '../src/gate/waiter.js'

const MINUTE = 60_000

function approvalRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 'approval-1',
    orgId: 'org-1',
    requestedBy: 'agent',
    toolName: 'mcp__agency__queue_touch',
    payload: {},
    risk: 'high',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decidedReason: null,
    expiresAt: new Date(Date.now() + 30 * MINUTE),
    chatSessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'toolu_1',
    payloadSha256: 'abc',
    createdAt: new Date(),
    updatedAt: null,
    ...over,
  } as ApprovalRow
}

function makeDeps(over: Partial<GateDeps> = {}) {
  const emitted: ChatEventBody[] = []
  const audited: string[] = []
  const ledger = createLedger()
  const deps: GateDeps = {
    orgId: 'org-1',
    chatSessionId: 'session-1',
    turnId: 'turn-1',
    ttlMs: 30 * MINUTE,
    turnDeadline: new Date(Date.now() + 35 * MINUTE),
    now: () => new Date(),
    parseToolInput: (_n, input) => ({ ok: true, value: input }),
    ensureApproval: async () => approvalRow(),
    waiter: { healthy: true, await: async (): Promise<Decision> => ({ status: 'approved' }) },
    ledger,
    disabledTools: new Set(),
    audit: async (action) => {
      audited.push(action)
    },
    emit: (e) => {
      emitted.push(e)
    },
    markGated: () => {},
    halted: () => false,
    log: { warn: () => {}, error: () => {} },
    ...over,
  }
  return { deps, emitted, audited, ledger }
}

const options = (over: Record<string, unknown> = {}) =>
  ({
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
    requestId: 'req_1',
    ...over,
  }) as unknown as Parameters<ReturnType<typeof makeCanUseTool>>[2]

describe('canUseTool always settles', () => {
  /**
   * The list is every branch in the function. If a new one is added without a
   * row here, this test still passes — which is why the source test below
   * bans `return null` outright rather than relying on coverage.
   */
  const scenarios: Array<[string, Partial<GateDeps>, string]> = [
    ['a refused tool', {}, 'Bash'],
    ['an unknown tool', {}, 'SomethingNew'],
    ['a low-risk tool', {}, 'mcp__agency__get_icp'],
    ['a forbidden channel', {}, 'mcp__agency__queue_touch'],
    [
      'an approval that was already denied',
      { ensureApproval: async () => approvalRow({ status: 'denied' }) },
      'mcp__agency__queue_touch',
    ],
    [
      'an approval that expires',
      { waiter: { healthy: true, await: async () => ({ status: 'expired' as const }) } },
      'mcp__agency__queue_touch',
    ],
    [
      'an aborted turn',
      { waiter: { healthy: true, await: async () => ({ status: 'aborted' as const }) } },
      'mcp__agency__queue_touch',
    ],
    [
      'a waiter that could not read the row',
      { waiter: { healthy: false, await: async () => ({ status: 'unavailable' as const }) } },
      'mcp__agency__queue_touch',
    ],
    [
      'a database that is down',
      {
        ensureApproval: async () => {
          throw new Error('ECONNREFUSED')
        },
      },
      'mcp__agency__queue_touch',
    ],
    [
      'a risk classifier that somehow throws',
      {
        parseToolInput: () => {
          throw new Error('boom')
        },
      },
      'mcp__agency__queue_touch',
    ],
    ['a halted runtime', { halted: () => true }, 'mcp__agency__get_icp'],
    [
      'a connector tool an owner turned off',
      { disabledTools: new Set(['mcp__stripe__create_refund']) },
      'mcp__stripe__create_refund',
    ],
    [
      'a server whose every tool is off',
      { disabledTools: new Set([connectorToolsEveryTool('zapier')]) },
      'mcp__zapier__gmail_send_email',
    ],
  ]

  it.each(scenarios)('returns a decision for %s', async (_label, over, toolName) => {
    const { deps } = makeDeps(over)
    const gate = makeCanUseTool(deps)
    const result = await gate(toolName, { channel: 'email' }, options())
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
    expect(['allow', 'deny']).toContain(result!.behavior)
  })

  it('denies rather than hanging when everything fails at once', async () => {
    const { deps } = makeDeps({
      ensureApproval: async () => {
        throw new Error('db down')
      },
      audit: async () => {
        throw new Error('audit down')
      },
      emit: () => {
        throw new Error('sse down')
      },
    })
    const result = await makeCanUseTool(deps)('mcp__agency__queue_touch', { channel: 'email' }, options())
    expect(result?.behavior).toBe('deny')
  })

  /**
   * Coverage cannot prove a branch that does not exist yet, so the literal is
   * banned from the file. `return null` in the catch is the one line that
   * turns a failure into a permanent hang.
   */
  it('contains no `return null` at all', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/gate/can-use-tool.ts', import.meta.url)),
      'utf8',
    )
    // Comments stripped first: this is a claim about the CODE, and the file
    // explains at length why that line must not exist.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/return\s+null/)
    expect(code).not.toMatch(/return\s+undefined/)
  })
})

describe('what the gate decides', () => {
  it('allows a read without asking anyone', async () => {
    const { deps, audited } = makeDeps({
      ensureApproval: async () => {
        throw new Error('should not have been called for a low-risk tool')
      },
    })
    const result = await makeCanUseTool(deps)('mcp__agency__get_icp', {}, options())
    expect(result).toEqual({ behavior: 'allow' })
    expect(audited).toContain('agent.tool_allow')
  })

  it('refuses a shell outright, and does not offer it to a human', async () => {
    const ensureApproval = vi.fn()
    const { deps, audited } = makeDeps({ ensureApproval })
    const result = await makeCanUseTool(deps)('Bash', { command: 'rm -rf /' }, options())
    expect(result?.behavior).toBe('deny')
    expect(ensureApproval).not.toHaveBeenCalled()
    expect(audited).toContain('agent.tool_refused')
  })

  /**
   * §2.1 and §12. Nobody is asked, because "high" would only mean a human is
   * asked, and a human can say yes.
   */
  it('refuses an SMS without raising an approval', async () => {
    const ensureApproval = vi.fn()
    const { deps } = makeDeps({ ensureApproval })
    const result = await makeCanUseTool(deps)(
      'mcp__agency__queue_touch',
      { channel: 'sms', body: 'hi' },
      options(),
    )
    expect(result?.behavior).toBe('deny')
    expect(ensureApproval).not.toHaveBeenCalled()
  })

  it('parks a high-risk call on a human and allows it once approved', async () => {
    const { deps, emitted, ledger } = makeDeps()
    const result = await makeCanUseTool(deps)(
      'mcp__agency__queue_touch',
      { channel: 'email', body: 'hello' },
      options(),
    )
    expect(result).toEqual({ behavior: 'allow' })
    expect(emitted.map((e) => e.kind)).toEqual(['approval_requested', 'approval_resolved'])
    expect(ledger.outstanding).toBe(1)
  })

  it('tells the model plainly when a human said no, and grants nothing', async () => {
    const { deps, ledger } = makeDeps({
      waiter: {
        healthy: true,
        await: async () => ({ status: 'denied', reason: 'wrong company' }),
      },
    })
    const result = await makeCanUseTool(deps)(
      'mcp__agency__queue_touch',
      { channel: 'email' },
      options(),
    )
    expect(result?.behavior).toBe('deny')
    expect(result && 'message' in result ? result.message : '').toContain('wrong company')
    expect(result && 'message' in result ? result.message : '').toContain('Do not retry')
    expect(ledger.outstanding).toBe(0)
  })

  /**
   * A denial must not become a second chance. The SDK redelivers permission
   * requests after a transport gap, and the approval row carries the answer.
   */
  it('does not re-ask when the approval was already decided', async () => {
    const { deps, ledger } = makeDeps({
      ensureApproval: async () => approvalRow({ status: 'denied', decidedReason: 'no' }),
      waiter: {
        healthy: true,
        await: async () => {
          throw new Error('should not wait on an already-decided approval')
        },
      },
    })
    const result = await makeCanUseTool(deps)('mcp__agency__queue_touch', { channel: 'email' }, options())
    expect(result?.behavior).toBe('deny')
    expect(ledger.outstanding).toBe(0)
  })

  it('never offers an "always allow", which would write the bypass itself', async () => {
    const { deps } = makeDeps()
    const result = await makeCanUseTool(deps)(
      'mcp__agency__get_icp',
      {},
      options({ suggestions: [{ type: 'addRules', rules: [{ toolName: 'mcp__agency__get_icp' }] }] }),
    )
    expect(result).toEqual({ behavior: 'allow' })
    expect(result && 'updatedPermissions' in result ? result.updatedPermissions : undefined).toBeUndefined()
  })

  it('does not rewrite the input, which would break the ledger check below it', async () => {
    const { deps } = makeDeps()
    const result = await makeCanUseTool(deps)('mcp__agency__get_icp', { a: 1 }, options())
    expect(result && 'updatedInput' in result ? result.updatedInput : undefined).toBeUndefined()
  })
})

/**
 * Settings → Connectors: a tool an owner turned off (connector-tool-disable).
 *
 * A refusal on top of `high`, never an allow. So the assertions are about
 * what does NOT happen — no approval row, no card, no grant — and about the
 * tool beside it on the same server, which must still reach a person.
 */
describe('a connector tool that was turned off', () => {
  const off = new Set(['mcp__stripe__create_refund', connectorToolsEveryTool('zapier')])

  it('is refused without an approval, a card or a grant', async () => {
    const ensureApproval = vi.fn()
    const { deps, emitted, audited, ledger } = makeDeps({ ensureApproval, disabledTools: off })
    const result = await makeCanUseTool(deps)('mcp__stripe__create_refund', { amount: 100 }, options())
    expect(result?.behavior).toBe('deny')
    expect(result && 'message' in result ? result.message : '').toMatch(/disabled in Settings → Connectors/)
    expect(result && 'message' in result ? result.message : '').toMatch(/Do not try a variation/)
    expect(ensureApproval).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
    expect(ledger.outstanding).toBe(0)
    expect(audited).toEqual(['agent.tool_disabled'])
  })

  it('is refused for every tool on a server that is off entirely', async () => {
    const ensureApproval = vi.fn()
    const { deps, emitted } = makeDeps({ ensureApproval, disabledTools: off })
    const result = await makeCanUseTool(deps)('mcp__zapier__slack_send_message', {}, options())
    expect(result?.behavior).toBe('deny')
    expect(ensureApproval).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
  })

  /** The deny is narrow: the tool beside it still parks on a human, as every connector tool does. */
  it('leaves the rest of the server asking a person, as before', async () => {
    const asked: string[] = []
    const { deps, emitted } = makeDeps({
      disabledTools: off,
      ensureApproval: async (req) => {
        asked.push(`${req.toolName}:${req.risk}`)
        return approvalRow({ toolName: req.toolName })
      },
    })
    const result = await makeCanUseTool(deps)('mcp__stripe__list_customers', {}, options())
    expect(result).toEqual({ behavior: 'allow' })
    expect(asked).toEqual(['mcp__stripe__list_customers:high'])
    expect(emitted[0]).toMatchObject({ kind: 'approval_requested', risk: 'high' })
  })

  it('does not reach another server whose name merely starts the same way', async () => {
    const ensureApproval = vi.fn(async () => approvalRow())
    const { deps } = makeDeps({ ensureApproval, disabledTools: off })
    await makeCanUseTool(deps)('mcp__zapier-two__slack_send_message', {}, options())
    expect(ensureApproval).toHaveBeenCalledTimes(1)
  })

  /**
   * BEFORE classification: whatever tier the classifier would give, a name
   * in the set is refused. (The runtime never puts the agency's own tools in
   * the set; this is about the order of the checks, not about that.)
   */
  it('is decided before the classifier, which would have allowed this one', async () => {
    const { deps } = makeDeps({ disabledTools: new Set(['mcp__agency__get_icp']) })
    const result = await makeCanUseTool(deps)('mcp__agency__get_icp', {}, options())
    expect(result?.behavior).toBe('deny')
  })

  it('still refuses when the audit write fails', async () => {
    const { deps } = makeDeps({
      disabledTools: off,
      audit: async () => {
        throw new Error('audit down')
      },
    })
    const result = await makeCanUseTool(deps)('mcp__stripe__create_refund', {}, options())
    expect(result?.behavior).toBe('deny')
  })

  /**
   * The order is a claim about the SOURCE as much as the behaviour: the check
   * sits inside the try (so a throw from it is still a deny), before
   * `classifyRisk`, and in both rings.
   */
  it.each(['can-use-tool.ts', 'pre-tool-use.ts'])('is checked before classifyRisk in %s', (file) => {
    const src = readFileSync(fileURLToPath(new URL(`../src/gate/${file}`, import.meta.url)), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const check = code.indexOf('connectorToolsIsDisabled(deps.disabledTools')
    const classify = code.indexOf('classifyRisk({')
    // The try of the callback itself, not a helper's above it.
    const tryAt = code.indexOf('try {', code.indexOf('return async ('))
    expect(tryAt).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    expect(classify).toBeGreaterThan(check)
    expect(check).toBeGreaterThan(tryAt)
  })

  /**
   * "A deny, never an allow." The disabled list must never find its way into
   * an allow-shaped option: a bare allowedTools entry auto-approves before the
   * gate is consulted, which is the opposite of what an owner asked for.
   */
  it.each(['gate/can-use-tool.ts', 'gate/pre-tool-use.ts', 'runtime/connectors.ts'])(
    'never names allowedTools in %s',
    (file) => {
      const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code).not.toMatch(/allowedTools/)
    },
  )
})

describe('an approval never outlives its turn', () => {
  /**
   * The boot check that AGENT_TURN_TIMEOUT_MINUTES > APPROVAL_TTL_MINUTES is
   * necessary and not sufficient: the two clocks start at different moments.
   * An approval raised ten minutes into a 35-minute turn with a 30-minute TTL
   * expires at minute 40 — five minutes in which a person sees a live card,
   * with a countdown, for a turn that no longer exists.
   */
  it('clamps the expiry to the turn’s wall clock', async () => {
    const now = new Date('2026-09-13T00:10:00.000Z')
    let asked: Date | undefined
    const { deps } = makeDeps({
      now: () => now,
      ttlMs: 30 * MINUTE,
      // The turn began at 00:00 with a 35-minute clock.
      turnDeadline: new Date('2026-09-13T00:35:00.000Z'),
      ensureApproval: async (req) => {
        asked = req.expiresAt
        return approvalRow({ expiresAt: req.expiresAt })
      },
    })
    await makeCanUseTool(deps)('mcp__agency__queue_touch', { channel: 'email' }, options())
    // 00:40 unclamped; 00:35 is when the turn dies.
    expect(asked?.toISOString()).toBe('2026-09-13T00:35:00.000Z')
  })

  it('leaves the TTL alone when the turn outlasts it, which is the usual case', async () => {
    const now = new Date('2026-09-13T00:00:00.000Z')
    let asked: Date | undefined
    const { deps } = makeDeps({
      now: () => now,
      ttlMs: 30 * MINUTE,
      turnDeadline: new Date('2026-09-13T00:35:00.000Z'),
      ensureApproval: async (req) => {
        asked = req.expiresAt
        return approvalRow({ expiresAt: req.expiresAt })
      },
    })
    await makeCanUseTool(deps)('mcp__agency__queue_touch', { channel: 'email' }, options())
    expect(asked?.toISOString()).toBe('2026-09-13T00:30:00.000Z')
  })
})

describe('the gate never claims an outcome that did not happen', () => {
  /**
   * A database the gate could not read is not an expiry. Both used to be
   * reported as `approval_resolved: expired`, which wrote "expired" onto a
   * card whose row was still pending — so a person could approve something
   * their own screen had already written off, and the audit log would carry a
   * decision for an action nothing performed.
   *
   * The row is closed out by the turn's `finally` instead, which is the one
   * place that knows the request is really dead.
   */
  it.each(['aborted', 'unavailable'] as const)(
    'emits no resolution when the wait ended as %s',
    async (status) => {
      const { deps, emitted } = makeDeps({
        waiter: { healthy: status !== 'unavailable', await: async () => ({ status }) },
      })
      const result = await makeCanUseTool(deps)(
        'mcp__agency__queue_touch',
        { channel: 'email' },
        options(),
      )
      expect(result?.behavior).toBe('deny')
      expect(emitted.some((e) => e.kind === 'approval_resolved')).toBe(false)
      // The request WAS shown, so the person knows what was asked.
      expect(emitted.some((e) => e.kind === 'approval_requested')).toBe(true)
    },
  )

  it.each(['expired', 'denied'] as const)('does resolve the card on a real %s', async (status) => {
    const { deps, emitted } = makeDeps({
      waiter: { healthy: true, await: async () => ({ status }) },
    })
    await makeCanUseTool(deps)('mcp__agency__queue_touch', { channel: 'email' }, options())
    expect(emitted.find((e) => e.kind === 'approval_resolved')).toMatchObject({ status })
  })

  /**
   * "The approval system could not be reached" and "nobody approved this in
   * time" are different facts, and the model reports whichever it is told.
   */
  it('tells the model the difference between an expiry and an outage', async () => {
    const expired = await makeCanUseTool(
      makeDeps({ waiter: { healthy: true, await: async () => ({ status: 'expired' as const }) } }).deps,
    )('mcp__agency__queue_touch', { channel: 'email' }, options())
    const unavailable = await makeCanUseTool(
      makeDeps({
        waiter: { healthy: false, await: async () => ({ status: 'unavailable' as const }) },
      }).deps,
    )('mcp__agency__queue_touch', { channel: 'email' }, options())

    expect(expired).toMatchObject({ behavior: 'deny' })
    expect(unavailable).toMatchObject({ behavior: 'deny' })
    expect((expired as { message: string }).message).toMatch(/expired/i)
    expect((unavailable as { message: string }).message).toMatch(/could not be reached/i)
  })
})

describe('the authorisation ledger', () => {
  it('authorises exactly one call per grant', () => {
    const l = createLedger()
    const fp = fingerprint('turn-1', 'mcp__agency__get_icp', '{}')
    l.grant(fp)
    expect(l.consume(fp)).toBe(true)
    expect(l.consume(fp)).toBe(false)
  })

  it('counts repeats, so one approval cannot authorise an unbounded number of calls', () => {
    const l = createLedger()
    const fp = fingerprint('turn-1', 'mcp__agency__scan_company', '{"domain":"a.test"}')
    l.grant(fp)
    l.grant(fp)
    expect(l.consume(fp)).toBe(true)
    expect(l.consume(fp)).toBe(true)
    expect(l.consume(fp)).toBe(false)
  })

  it('will not let a grant from one turn authorise the same call in another', () => {
    const l = createLedger()
    l.grant(fingerprint('turn-1', 'x', '{}'))
    expect(l.consume(fingerprint('turn-2', 'x', '{}'))).toBe(false)
  })

  it('refuses a call nobody granted — which is what a bypass looks like', () => {
    const l = createLedger()
    expect(l.consume(fingerprint('turn-1', 'mcp__agency__queue_touch', '{}'))).toBe(false)
  })
})

describe('the PreToolUse backstop', () => {
  const deps: HookDeps = { audit: async () => {}, log: { error: () => {} }, disabledTools: new Set() }

  const hookInput = (toolName: string, toolInput: Record<string, unknown> = {}) => ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_1',
    session_id: 'sdk-1',
  })

  /**
   * This is the whole reason the hook exists. 'ask' FORCES the permission
   * prompt even where a bare allowedTools entry or a settings allow rule would
   * have auto-approved the call before canUseTool was ever consulted.
   */
  it('forces a prompt for anything above low risk', async () => {
    const out = await makePreToolUse(deps)(hookInput('mcp__agency__queue_touch', { channel: 'email' }))
    expect(out['hookSpecificOutput']).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    })
  })

  it('denies a refused tool at the hook, before the gate is even reached', async () => {
    const out = await makePreToolUse(deps)(hookInput('Bash', { command: 'ls' }))
    expect(out['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny' })
  })

  /**
   * Returning 'allow' here would SETTLE the permission and skip canUseTool —
   * quietly moving the gate into a hook that cannot wait for a person. §2.4
   * says the gate is canUseTool.
   */
  it('stays silent for a read, leaving canUseTool to decide', async () => {
    const out = await makePreToolUse(deps)(hookInput('mcp__agency__get_icp'))
    expect(out).toEqual({})
  })

  it('audits every call, including a subagent’s', async () => {
    const seen: Array<Record<string, unknown>> = []
    const hook = makePreToolUse({
      audit: async (_a, detail) => {
        seen.push(detail)
      },
      log: { error: () => {} },
      disabledTools: new Set(),
    })
    await hook({ ...hookInput('mcp__agency__get_icp'), agent_id: 'sub-1', agent_type: 'qualifier' })
    expect(seen[0]).toMatchObject({ agentId: 'sub-1', agentType: 'qualifier' })
  })

  it('declines to decide rather than allowing, if it fails', async () => {
    const hook = makePreToolUse({
      audit: async () => {
        throw new Error('audit down')
      },
      log: { error: () => {} },
      disabledTools: new Set(),
    })
    const out = await hook(hookInput('mcp__agency__queue_touch', { channel: 'email' }))
    // Empty: canUseTool, which is fail-closed, still answers.
    expect(out).toEqual({})
  })

  /**
   * Ring 2 refuses a turned-off tool too, and that is what makes it hold: a
   * deny from this hook settles the call even where a bare allowedTools
   * entry or a settings rule would have approved it before canUseTool.
   */
  it('denies a tool an owner turned off, without asking, and audits it', async () => {
    const actions: string[] = []
    const hook = makePreToolUse({
      audit: async (action) => {
        actions.push(action)
      },
      log: { error: () => {} },
      disabledTools: new Set(['mcp__stripe__create_refund', connectorToolsEveryTool('zapier')]),
    })
    for (const name of ['mcp__stripe__create_refund', 'mcp__zapier__gmail_send_email']) {
      const out = await hook(hookInput(name))
      expect(out['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny' })
      expect(JSON.stringify(out)).toMatch(/disabled in Settings → Connectors/)
    }
    expect(actions).toEqual(['agent.tool_disabled', 'agent.tool_disabled'])
    // The tool beside it still forces the prompt, exactly as before.
    const beside = await hook(hookInput('mcp__stripe__list_customers'))
    expect(beside['hookSpecificOutput']).toMatchObject({ permissionDecision: 'ask' })
  })

  it('denies a turned-off tool even when its audit write fails', async () => {
    const hook = makePreToolUse({
      audit: async () => {
        throw new Error('audit down')
      },
      log: { error: () => {} },
      disabledTools: new Set(['mcp__stripe__create_refund']),
    })
    const out = await hook(hookInput('mcp__stripe__create_refund'))
    expect(out['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny' })
  })

  it('ignores events that are not PreToolUse', async () => {
    expect(await makePreToolUse(deps)({ hook_event_name: 'SessionStart' })).toEqual({})
  })

  it('never records a tool result body in the audit log', async () => {
    const seen: Array<Record<string, unknown>> = []
    const hook = makePostToolUse({
      audit: async (_a, detail) => {
        seen.push(detail)
      },
      log: { error: () => {} },
      disabledTools: new Set(),
    })
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__agency__get_company',
      tool_use_id: 'toolu_1',
      tool_response: { secret: 'a company’s evidence' },
    })
    expect(JSON.stringify(seen)).not.toContain('evidence')
  })
})

describe('the approval waiter', () => {
  const log = { warn: () => {}, error: () => {} }
  const base = {
    now: () => new Date(),
    sleep: async () => {},
    pollMs: 1,
    readRetries: 3,
    log,
  }

  it('returns a decision that is already on the row, without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    const w = createApprovalWaiter({
      ...base,
      sleep,
      read: async () => approvalRow({ status: 'approved', decidedBy: 'user-1' }),
      expire: async () => null,
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() + MINUTE) })
    expect(d).toMatchObject({ status: 'approved', decidedBy: 'user-1' })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('polls until a human answers', async () => {
    let reads = 0
    const w = createApprovalWaiter({
      ...base,
      read: async () => {
        reads += 1
        return reads < 3 ? approvalRow() : approvalRow({ status: 'denied', decidedReason: 'no' })
      },
      expire: async () => null,
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() + MINUTE) })
    expect(d).toMatchObject({ status: 'denied', reason: 'no' })
    expect(reads).toBe(3)
  })

  it('expires against the ROW’s deadline, not an independent timer', async () => {
    const expire = vi.fn(async () => approvalRow({ status: 'expired' }))
    const w = createApprovalWaiter({
      ...base,
      read: async () => approvalRow({ expiresAt: new Date(Date.now() - MINUTE) }),
      expire,
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() - MINUTE) })
    expect(d.status).toBe('expired')
    expect(expire).toHaveBeenCalled()
  })

  /**
   * A decision landing in the same instant as the deadline wins. The expiry
   * UPDATE matches nothing, and the waiter re-reads rather than assuming.
   */
  it('lets a decision that lands on the deadline win', async () => {
    let reads = 0
    const w = createApprovalWaiter({
      ...base,
      read: async () => {
        reads += 1
        return reads === 1
          ? approvalRow({ expiresAt: new Date(Date.now() - 1) })
          : approvalRow({ status: 'approved', decidedBy: 'user-9' })
      },
      expire: async () => null, // the conditional UPDATE matched nothing
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() - 1) })
    expect(d).toMatchObject({ status: 'approved', decidedBy: 'user-9' })
  })

  /**
   * The correction that matters most. A bare read with no tolerance turns a
   * two-second database blip during a twenty-minute wait into a permanent
   * denial of a live approval — while the row stays pending and the human
   * approves into nothing.
   */
  it('survives a transient database failure rather than denying a live approval', async () => {
    let reads = 0
    const w = createApprovalWaiter({
      ...base,
      read: async () => {
        reads += 1
        if (reads <= 2) throw new Error('ECONNRESET')
        return approvalRow({ status: 'approved' })
      },
      expire: async () => null,
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() + MINUTE) })
    expect(d.status).toBe('approved')
    expect(w.healthy).toBe(true)
  })

  it('gives up by settling, never by hanging, once the read budget is spent', async () => {
    const w = createApprovalWaiter({
      ...base,
      read: async () => {
        throw new Error('database gone')
      },
      expire: async () => null,
    })
    const d = await w.await('approval-1', { deadline: new Date(Date.now() + MINUTE) })
    // 'unavailable', not 'aborted'. The row was never touched and may still be
    // pending on somebody's screen — the DATABASE is what could not be
    // reached, not the human. Reported as an expiry (which it was), the card
    // said "expired" while the row was still live and still decidable.
    expect(d.status).toBe('unavailable')
    expect(w.healthy).toBe(false)
  })

  it('settles when the turn is aborted', async () => {
    const ac = new AbortController()
    const w = createApprovalWaiter({
      ...base,
      sleep: async () => {
        ac.abort()
      },
      read: async () => approvalRow(),
      expire: async () => null,
    })
    const d = await w.await('approval-1', { signal: ac.signal, deadline: new Date(Date.now() + MINUTE) })
    expect(d.status).toBe('aborted')
  })

  it('settles when the row disappears underneath it', async () => {
    const w = createApprovalWaiter({ ...base, read: async () => null, expire: async () => null })
    const d = await w.await('gone', { deadline: new Date(Date.now() + MINUTE) })
    expect(d.status).toBe('unavailable')
  })
})

describe('abortableSleep', () => {
  it('wakes early when the turn is stopped', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = abortableSleep(60_000, ac.signal)
    ac.abort()
    await p
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('returns immediately if already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await abortableSleep(60_000, ac.signal)
  })
})

/**
 * Internal writes run at once (operator decision, 2026-10-06), and the rest of
 * the line holds. These go through the REAL classifier and the real gate, so
 * they prove the decision `runsWithoutApproval` makes is the one a turn gets —
 * and that an internal write is still granted single-use and still audited,
 * exactly as a read is, rather than slipping past the ledger.
 */
describe('internal writes run without a card; what reaches a person keeps one', () => {
  it('runs an internal write at once — granted, audited as what it is, no card', async () => {
    const ensureApproval = vi.fn()
    const details: Record<string, unknown>[] = []
    const { deps, emitted, ledger } = makeDeps({
      ensureApproval,
      audit: async (action, detail) => {
        if (action === 'agent.tool_allow') details.push(detail)
      },
    })
    const result = await makeCanUseTool(deps)(
      'mcp__agency__add_note',
      { companyId: 'c-1', body: 'Spoke to their CTO.' },
      options(),
    )
    expect(result).toEqual({ behavior: 'allow' })
    expect(ensureApproval).not.toHaveBeenCalled()
    expect(emitted.some((e) => e.kind === 'approval_requested')).toBe(false)
    // Single-use grant: the handler's ledger check still has something to spend.
    expect(ledger.outstanding).toBe(1)
    // Audited as an internal write, not dressed up as a read.
    expect(details).toEqual([
      expect.objectContaining({ toolName: 'mcp__agency__add_note', risk: 'medium', rule: 'writes_internal_state' }),
    ])
  })

  it.each(['update_deal', 'add_company', 'create_campaign', 'generate_proposal', 'add_suppression', 'pause_contact'])(
    'runs %s at once',
    async (tool) => {
      const ensureApproval = vi.fn()
      const { deps } = makeDeps({ ensureApproval })
      const result = await makeCanUseTool(deps)(`mcp__agency__${tool}`, {}, options())
      expect(result).toEqual({ behavior: 'allow' })
      expect(ensureApproval).not.toHaveBeenCalled()
    },
  )

  it.each(['queue_touch', 'enrol_contacts', 'resume_contact'])('still parks %s on a person', async (tool) => {
    const ensureApproval = vi.fn(async () => approvalRow())
    const { deps, emitted } = makeDeps({ ensureApproval })
    await makeCanUseTool(deps)(`mcp__agency__${tool}`, { channel: 'email' }, options())
    expect(ensureApproval).toHaveBeenCalledTimes(1)
    expect(emitted.some((e) => e.kind === 'approval_requested')).toBe(true)
  })

  it('still parks a third-party connector tool on a person', async () => {
    const ensureApproval = vi.fn(async () => approvalRow())
    const { deps } = makeDeps({ ensureApproval })
    await makeCanUseTool(deps)('mcp__zapier__send_email', { to: 'a@b.co' }, options())
    expect(ensureApproval).toHaveBeenCalledTimes(1)
  })

  it('still parks delegation to a subagent on a person', async () => {
    const ensureApproval = vi.fn(async () => approvalRow())
    const { deps } = makeDeps({ ensureApproval })
    await makeCanUseTool(deps)(
      'Agent',
      { description: 'research', prompt: 'look into acme', subagent_type: 'researcher' },
      options(),
    )
    expect(ensureApproval).toHaveBeenCalledTimes(1)
  })
})
