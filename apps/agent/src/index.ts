import { and, eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import {
  appendChatMessage, clearTurnRunning, ensureChatSessionTitle, markTurnRunning,
  schema, sessionCostUsd, setSdkSessionId, usd, type AgencyDb,
} from '@agency/db'
import { loadEnv } from './env.js'
import { createLogger, type Logger } from './logger.js'
import { startHealthServer } from './health.js'
import { acquireWorkerLock } from './boot/singleton.js'
import { reconcileAfterRestart, sweepExpired } from './boot/reconcile.js'
import { createAgentHttpServer, type StartTurnRequest, type TurnHandle } from './http/server.js'
import { createDeferredEmitter, startTurn } from './chat/turn.js'
import { buildTurnRuntime, createHalt, resolvePrincipal, type RuntimeHalt } from './runtime/session.js'

/**
 * The agent worker.
 *
 * PROMPT.md §3 keeps this a separate long-running process so the web app never
 * blocks on an agent turn. It has a second effect that matters just as much:
 * the Agent SDK and `ANTHROPIC_API_KEY` stay out of the Next module graph, and
 * CI builds the web app with no secrets on purpose.
 *
 * Boot order matters and is not rearrangeable:
 *
 *   1. health, so an orchestrator gets an answer while the rest comes up;
 *   2. the database;
 *   3. the SINGLE-WORKER LOCK, because step 4 is destructive;
 *   4. reconcile what the last worker left behind;
 *   5. only then accept a turn.
 *
 * Reconciling before taking the lock would let this worker cancel a healthy
 * second worker's live turns. Accepting a turn before reconciling would mean
 * serving a conversation whose previous turn is still marked as running.
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const log = createLogger(env.LOG_LEVEL)
  const bootAt = new Date()

  let pool: Pool | null = null
  const health = await startHealthServer(env.AGENT_PORT, () => pool, log)

  pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX })
  const db = drizzle(pool, { schema }) as unknown as AgencyDb

  try {
    await pool.query('SELECT 1')
    log.info('database reachable')
  } catch (err) {
    log.error('database unreachable at startup', {
      error: err instanceof Error ? err.name : 'UnknownError',
    })
  }

  const lock = await acquireWorkerLock({ connectionString: env.DATABASE_URL, log })
  await reconcileAfterRestart(db, bootAt, log)

  const sweeper = setInterval(() => {
    void sweepExpired(db, log)
  }, env.APPROVAL_SWEEP_MS)
  sweeper.unref()

  const halt = createHalt(log)
  const running = new Map<string, TurnHandle>()

  if (!env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY is not set — chat refuses turns; everything else still runs')
  }

  const server = createAgentHttpServer({
    port: env.AGENT_PORT,
    token: env.AGENT_INTERNAL_TOKEN,
    log,
    health: (url) => answerHealth(url, pool, halt, Boolean(env.ANTHROPIC_API_KEY)),
    interrupt: (turnId) => {
      const turn = running.get(turnId)
      if (!turn) return false
      turn.interrupt()
      return true
    },
    startTurn: (req) =>
      beginTurn({ req, db, env, log, halt, running }),
  })

  const apiPort = env.AGENT_PORT + 1
  await new Promise<void>((resolve) => server.listen(apiPort, '127.0.0.1', resolve))
  log.info('agent worker started', {
    nodeEnv: env.NODE_ENV,
    healthPort: env.AGENT_PORT,
    apiPort,
    chat: env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled',
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal, runningTurns: running.size })
    clearInterval(sweeper)
    // Interrupt rather than abandon: an aborted turn still runs its `finally`,
    // which releases the conversation claim and emits turn_finished. Leaving
    // them for the next boot's reconciler would work, but a clean stop is
    // better than a recovery.
    for (const turn of running.values()) turn.interrupt()
    try {
      await new Promise<void>((res) => server.close(() => res()))
      await health.close()
      await lock.release()
      await pool?.end()
      log.info('shutdown complete')
      process.exit(0)
    } catch (err) {
      log.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) })
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

async function answerHealth(
  url: string,
  pool: Pool | null,
  halt: RuntimeHalt,
  chatEnabled: boolean,
): Promise<{ status: number; body: unknown } | null> {
  if (url !== '/livez' && url !== '/readyz') return null
  if (url === '/livez') return { status: 200, body: { status: 'ok', service: 'agent' } }
  try {
    await pool?.query('SELECT 1')
    // A halted runtime is NOT ready. It still answers, and it says why — an
    // orchestrator restarting it is the correct response to a gate that was
    // bypassed.
    return {
      status: halt.halted() ? 503 : 200,
      body: {
        status: halt.halted() ? 'halted' : 'ok',
        service: 'agent',
        database: 'ok',
        chat: chatEnabled ? 'enabled' : 'disabled',
      },
    }
  } catch (err) {
    // Only the error class: a driver error can carry the DSN (§2.3).
    return {
      status: 503,
      body: {
        status: 'degraded',
        service: 'agent',
        database: 'unreachable',
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    }
  }
}

/**
 * Start one turn.
 *
 * The order inside here is the interesting part. The gate is built BEFORE the
 * turn, because it closes over the turn id that its approval rows are keyed
 * on — so it is handed a deferred emitter, which buffers until there is a
 * stream to write into. The user's own message is written before the turn
 * runs, so a browser that reattaches sees what was asked even if the answer
 * never arrived.
 */
async function beginTurn(args: {
  req: StartTurnRequest
  db: AgencyDb
  env: ReturnType<typeof loadEnv>
  log: Logger
  halt: RuntimeHalt
  running: Map<string, TurnHandle>
}): Promise<{ ok: true; turn: TurnHandle } | { ok: false; status: number; message: string }> {
  const { req, db, env, log, halt, running } = args

  if (!env.ANTHROPIC_API_KEY) return { ok: false, status: 503, message: 'chat_disabled' }
  if (halt.halted()) return { ok: false, status: 503, message: 'runtime_halted' }

  // The user named in the body is a CLAIM. This checks the conversation
  // actually belongs to them, so a forged body can only address a thread that
  // already exists and already belongs to the user it names.
  const who = await resolvePrincipal(db, req.chatSessionId, req.userId)
  if (!who) return { ok: false, status: 404, message: 'no_such_conversation' }

  const gateEmitter = createDeferredEmitter()

  const runtime = await buildTurnRuntime(
    {
      db,
      log,
      halt,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.AGENT_MODEL,
      maxTurns: env.AGENT_MAX_TURNS,
      maxBudgetUsd: env.AGENT_MAX_BUDGET_USD,
      approvalTtlMs: env.APPROVAL_TTL_MINUTES * 60_000,
      approvalPollMs: env.APPROVAL_POLL_MS,
      cwd: process.cwd(),
      now: () => new Date(),
    },
    {
      orgId: who.orgId,
      orgName: who.orgName,
      chatSessionId: req.chatSessionId,
      principal: who.principal,
      resume: who.sdkSessionId,
      emit: (body) => gateEmitter.emit(body),
    },
  )

  let seq = 0
  await appendChatMessage(db, {
    orgId: who.orgId,
    sessionId: req.chatSessionId,
    turnId: runtime.turnId,
    seq: seq++,
    role: 'user',
    content: { text: req.text },
  })
  await ensureChatSessionTitle(db, who.orgId, req.chatSessionId, req.text)

  const turn = startTurn(
    {
      orgId: who.orgId,
      sessionId: req.chatSessionId,
      userId: req.userId,
      turnId: runtime.turnId,
      claim: () => markTurnRunning(db, who.orgId, req.chatSessionId, runtime.turnId),
      release: () => clearTurnRunning(db, who.orgId, req.chatSessionId, runtime.turnId),
      sessionCostSoFar: () => sessionCostUsd(db, who.orgId, req.chatSessionId),
      sessionBudgetUsd: env.AGENT_SESSION_BUDGET_USD,
      setSdkSessionId: (id) => setSdkSessionId(db, who.orgId, req.chatSessionId, id),
      usd,
      now: () => new Date(),
      log,
      persist: async (event) => {
        // Only what a reattaching browser needs to rebuild the thread. Text
        // deltas are not persisted: the completed message carries the same
        // words, and there are hundreds of the former per answer.
        if (event.kind === 'message_complete') {
          if (!event.text) return
          await appendChatMessage(db, {
            orgId: who.orgId, sessionId: req.chatSessionId, turnId: runtime.turnId,
            seq: seq++, role: 'assistant', content: { text: event.text },
          })
        } else if (event.kind === 'tool_call') {
          await appendChatMessage(db, {
            orgId: who.orgId, sessionId: req.chatSessionId, turnId: runtime.turnId,
            seq: seq++, role: 'assistant', toolName: event.toolName, toolUseId: event.toolUseId,
            content: { kind: 'tool_call', input: event.input, risk: event.risk, displayName: event.displayName },
          })
        } else if (event.kind === 'tool_result') {
          await appendChatMessage(db, {
            orgId: who.orgId, sessionId: req.chatSessionId, turnId: runtime.turnId,
            seq: seq++, role: 'tool', toolUseId: event.toolUseId,
            content: { kind: 'tool_result', ok: event.ok, summary: event.summary },
          })
        } else if (event.kind === 'cost') {
          // The turn's cost rides on the USER's row: one turn, one cost, and
          // no ambiguity about which of several assistant rows carries it.
          await db
            .update(schema.chatMessages)
            .set({
              costUsd: event.turnCostUsd,
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
            })
            .where(
              and(
                eq(schema.chatMessages.sessionId, req.chatSessionId),
                eq(schema.chatMessages.turnId, runtime.turnId),
                eq(schema.chatMessages.role, 'user'),
              ),
            )
        }
      },
    },
    {
      text: req.text,
      options: runtime.options,
      abort: runtime.abort,
      timeoutMs: env.AGENT_TURN_TIMEOUT_MINUTES * 60_000,
    },
  )

  // Now there is a stream. Anything the gate buffered goes first, and
  // everything after forwards straight through.
  gateEmitter.bind((body) => turn.emit(body))

  running.set(runtime.turnId, turn)
  return {
    ok: true,
    turn: {
      turnId: turn.turnId,
      interrupt: () => turn.interrupt(),
      async *events() {
        try {
          yield* turn.events()
        } finally {
          running.delete(turn.turnId)
        }
      },
    } satisfies TurnHandle,
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'agent',
      msg: 'failed to start',
      error: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    }),
  )
  process.exit(1)
})
