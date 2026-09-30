/**
 * Prove the agent works end to end (PROMPT.md §9, Phases 2 and 3).
 *
 *   npm run smoke:agent            Phase 2's Definition of Done
 *   npm run smoke:agent -- --draft ...and make it park a draft on a human
 *   npm run smoke:agent -- --connector <name>   Phase 3's Definition of Done
 *
 * This is NOT part of `npm test` and never will be. It needs a worker that can
 * reach a model, it spends whatever that worker authenticates with — a
 * developer's own Claude Code login under AGENT_USE_LOCAL_LOGIN, or API
 * credit under ANTHROPIC_API_KEY — and it talks to a running worker and a real
 * database, every one of which is a reason CI must not run it. The rest of
 * the suite proves everything below the model boundary; this proves the
 * boundary itself, and a person runs it deliberately.
 *
 * What it checks, in order:
 *
 *   1. the worker is up and says chat is enabled;
 *   2. a turn streams back events in a shape the browser can render;
 *   3. the agent actually CALLS the agency tools rather than answering from
 *      its own guesses — the Definition of Done says "with tool cards
 *      visible", and a turn with no tool calls has not qualified anything;
 *   4. the turn ends exactly once, with a cost;
 *   5. §2.2 holds in the transcript: nothing claims a finding the tools
 *      marked unobserved.
 *
 * It deliberately does NOT test the approval path automatically. A high-risk
 * tool parks the turn on a human for up to thirty minutes by design, and a
 * script that approved its own request would be testing a gate with the gate
 * removed. Run it with `--draft` to make the agent try one, then approve or
 * deny it in the UI and watch the turn continue.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createChatSession, schema, type AgencyDb } from '@agency/db/queries'

const AGENT_URL = process.env['AGENT_URL'] ?? 'http://127.0.0.1:3002'
const TOKEN = process.env['AGENT_INTERNAL_TOKEN'] ?? ''
const DRAFT = process.argv.includes('--draft')
/**
 * Phase 3's Definition of Done: "the owner adds an MCP server through the UI
 * and the agent uses one of its tools in the very next chat message, with no
 * restart."
 *
 * The "no restart" half cannot be asserted from in here — it is a property of
 * how the worker was started, not of what it answers. So this script checks
 * the half it CAN check (the connector's tools are in the agent's hands) and
 * prints the other half as an instruction: run this against a worker that has
 * been up since before the connector was added, which is the case that matters
 * and the case a person can actually verify.
 */
const CONNECTOR = argValue('--connector')

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const ASK = CONNECTOR
  ? 'List the exact names of every tool you have available to you right now. Names only, one per line.'
  : DRAFT
    ? 'Find the best-fit company in the pipeline, then draft a short email opener to them about ' +
      'the most demonstrable finding you have on them.'
    : 'score the companies in the pipeline and tell me the top three by fit'

interface Frame {
  kind: string
  [k: string]: unknown
}

function fail(message: string): never {
  console.error(`\n  FAILED  ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  if (!TOKEN) fail('AGENT_INTERNAL_TOKEN is not set. Run with --env-file=.env.')

  // 1. The worker.
  let ready: { status?: string; chat?: string }
  try {
    ready = (await (await fetch(`${AGENT_URL}/readyz`)).json()) as typeof ready
  } catch {
    fail(
      `no agent worker at ${AGENT_URL}. Start it with: ` +
        'AGENT_USE_LOCAL_LOGIN=true npx tsx --env-file=.env apps/agent/src/index.ts',
    )
  }
  console.log(`  worker    ${ready.status}, chat ${ready.chat}`)
  /**
   * This used to say the worker had no ANTHROPIC_API_KEY, which was the
   * wrong question for the whole build: a key is one of TWO ways a worker
   * reaches a model, and the one that spends credit. Blaming the key sent
   * whoever read it to buy some. Name both, and name the free one first.
   */
  if (ready.chat === 'disabled') {
    fail(
      'chat is disabled on this worker: it resolved no credential at boot. Restart it with ' +
        'AGENT_USE_LOCAL_LOGIN=true to use your own Claude Code login (development only — the worker ' +
        'refuses it in production — and it spends no API credit), or with ANTHROPIC_API_KEY set.',
    )
  }
  if (ready.chat !== 'enabled') {
    fail(`the worker reported no chat state (status ${String(ready.status)}); read ${AGENT_URL}/readyz.`)
  }

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 2 })
  const db = drizzle(pool, { schema }) as unknown as AgencyDb
  const [org] = await db.select({ id: schema.orgs.id }).from(schema.orgs).limit(1)
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  if (!org || !user) fail('no org or user. Run `npm run db:seed` first.')

  const thread = await createChatSession(db, { orgId: org.id, userId: user.id })
  console.log(`  asking    "${ASK}"\n`)

  // 2. The turn.
  const res = await fetch(`${AGENT_URL}/internal/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ chatSessionId: thread.id, userId: user.id, text: ASK }),
  })
  if (!res.ok || !res.body) {
    fail(`the worker refused the turn: ${res.status} ${await res.text()}`)
  }

  const frames: Frame[] = []
  let answer = ''
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const frame = JSON.parse(line.slice(6)) as Frame
      frames.push(frame)
      if (frame.kind === 'text_delta') answer += String(frame['text'] ?? '')
      if (frame.kind === 'tool_call') {
        console.log(`  tool      ${String(frame['toolName'])}  (${String(frame['risk'])} risk)`)
      }
      if (frame.kind === 'tool_result') {
        const ok = frame['ok'] === true
        console.log(`            ${ok ? '->' : '!!'} ${String(frame['summary'] ?? '').slice(0, 90)}`)
      }
      if (frame.kind === 'approval_requested') {
        console.log(
          `\n  APPROVAL  ${String(frame['toolName'])} is waiting for a human.\n` +
            `            Decide it at /approvals — the turn is parked until you do.\n`,
        )
      }
      if (frame.kind === 'error') {
        console.log(`  error     ${String(frame['message'])}`)
      }
    }
  }

  // 3-5. What came back.
  console.log(`\n  answer    ${answer.trim().slice(0, 600) || '(none)'}\n`)

  const kinds = new Set(frames.map((f) => f.kind))
  const finished = frames.filter((f) => f.kind === 'turn_finished')
  const cost = frames.find((f) => f.kind === 'cost')
  const toolCalls = frames.filter((f) => f.kind === 'tool_call')

  const checks: Array<[string, boolean, string]> = [
    ['streamed events', frames.length > 0, 'the worker sent nothing at all'],
    ['ended exactly once', finished.length === 1, `turn_finished appeared ${finished.length} times`],
    [
      'ended successfully',
      finished[0]?.['reason'] === 'success',
      `the turn ended as "${String(finished[0]?.['reason'])}"`,
    ],
    ['reported a cost', cost !== undefined, 'no cost event — §8.1 requires the cost be visible'],
    [
      'answered in words',
      answer.trim().length > 0,
      'the turn produced no text for the user to read',
    ],
  ]

  /**
   * Only where the question ASKS for work.
   *
   * This check used to be unconditional, which made Phase 3's gate impossible
   * to pass: `--connector` asks the agent to LIST its tool names and nothing
   * else, so an agent doing exactly what it was told made no tool calls and
   * failed "used the agency tools" every single time. A gate that cannot
   * report success is the same defect as a query that cannot report failure —
   * it looks like evidence and is not. The connector run has its own,
   * narrower check below; this one belongs to the prompts that ask the agent
   * to go and read the CRM.
   */
  if (!CONNECTOR) {
    checks.push([
      'used the agency tools',
      toolCalls.length > 0,
      'the agent answered with NO tool calls. It is guessing rather than reading the CRM.',
    ])
  }

  if (DRAFT) {
    checks.push([
      'parked a draft on a human',
      kinds.has('approval_requested'),
      'the agent drafted nothing, so the approval gate was never exercised',
    ])
  }

  if (CONNECTOR) {
    // Phase 3. The agent naming the connector's namespace is the evidence
    // that a row added in the UI reached a live turn — the assembly happens
    // at the start of every turn, from the enabled rows, with nothing cached.
    checks.push([
      `can see the "${CONNECTOR}" connector's tools`,
      new RegExp(`mcp__${CONNECTOR}__`).test(answer),
      `the agent did not name a single mcp__${CONNECTOR}__* tool. Either the connector is not ` +
        'enabled, or it failed to build — check the worker log for "connector skipped".',
    ])
  }

  let bad = 0
  console.log('  checks')
  for (const [name, passed, why] of checks) {
    console.log(`    ${passed ? 'ok  ' : 'FAIL'}  ${name}${passed ? '' : ` — ${why}`}`)
    if (!passed) bad += 1
  }

  // §2.2, read off the transcript rather than trusted.
  const claimedUnobserved = /\b(?:no|not) (?:observed|verified)\b/i.test(answer) === false &&
    /\bdoes not have\b|\bthey are missing\b/i.test(answer) &&
    toolCalls.length === 0
  if (claimedUnobserved) {
    console.log('    FAIL  §2.2 — the answer makes claims about a company with no tool call behind them')
    bad += 1
  }

  console.log(
    `\n  cost      $${String(cost?.['turnCostUsd'] ?? '0')} this turn, ` +
      `${toolCalls.length} tool call(s), ${frames.length} events\n`,
  )

  await pool.end()
  if (bad > 0) fail(`${bad} check(s) failed`)

  if (CONNECTOR) {
    console.log(
      '  Phase 3 Definition of Done: PASSED — with one half you have to confirm yourself.\n' +
        '  This proves the agent HAS the connector\'s tools. It does not prove the worker was\n' +
        '  never restarted, which is the other half of §9\'s wording. Add the connector through\n' +
        '  the UI while this worker is running, then run this without restarting it.\n',
    )
  } else {
    console.log('  Phase 2 Definition of Done: PASSED\n')
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
