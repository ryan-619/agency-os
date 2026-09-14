import { and, eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import {
  appendAudit, appendChatMessage, cancelPendingApprovals, clearTurnRunning,
  createSmtpProvider, ensureChatSessionTitle, markTurnRunning, masterKey, readConnector, schema,
  sessionCostUsd, setSdkSessionId, usd, type AgencyDb,
} from '@agency/db'
import { loadEnv } from './env.js'
import { createLogger, type Logger } from './logger.js'
import { answerHealth, startHealthServer, type HealthInputs } from './health.js'
import { acquireWorkerLock, type WorkerLock } from './boot/singleton.js'
import { reconcileAfterRestart, recoverStuckSends, sweepExpired } from './boot/reconcile.js'
import { startSender } from './outreach/sender.js'
import { startInbox } from './outreach/inbox.js'
import { createAgentHttpServer, type StartTurnRequest, type TurnHandle } from './http/server.js'
import { createDeferredEmitter, startTurn } from './chat/turn.js'
import { buildTurnRuntime, createHalt, resolvePrincipal, type RuntimeHalt } from './runtime/session.js'
import { probeConnector } from './runtime/probe.js'
import { inspectSkillsRoot } from './runtime/skills.js'

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
  // Nothing below exists yet, which is the point: /livez answers immediately
  // and /readyz reports "starting" rather than refusing the connection.
  let halt: RuntimeHalt | null = null
  let lock: WorkerLock | null = null
  const outreachMode = outreachModeFrom(env)
  const healthInputs = (): HealthInputs => ({
    pool,
    halted: halt?.halted() ?? false,
    chatEnabled: Boolean(env.ANTHROPIC_API_KEY),
    lockHeld: lock?.held ?? null,
    outreach: outreachMode,
  })
  const health = await startHealthServer(env.AGENT_PORT, healthInputs, log)

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

  lock = await acquireWorkerLock({ connectionString: env.DATABASE_URL, log })
  await reconcileAfterRestart(db, bootAt, log)
  await recoverStuckSends(db, bootAt, log)

  const sweeper = setInterval(() => {
    void sweepExpired(db, log)
  }, env.APPROVAL_SWEEP_MS)
  sweeper.unref()

  halt = createHalt(log)
  const running = new Map<string, TurnHandle>()

  /**
   * Resolved ONCE, here, rather than on every turn.
   *
   * A malformed SECRETS_KEY is a configuration mistake, and it should be a
   * line in the boot log — not a surprise at the moment someone asks a
   * question that happens to need a connector. Unset is not an error: a
   * deployment with no connectors needs no key, and a connector that does need
   * one is skipped with a reason.
   */
  /**
   * §6's skills, decided once from what is actually on the volume.
   *
   * Loading skills means loading the project setting source, and a settings
   * file in that source can allow tool calls the gate never sees. So this
   * REFUSES rather than warns, and it refuses loudly — but it never stops the
   * worker: the agent works perfectly well without skills.
   */
  const skills = inspectSkillsRoot(env.AGENT_SKILLS_DIR)
  log[skills.status === 'refused' ? 'error' : 'info'](`skills: ${skills.status}`, {
    reason: skills.reason,
    ...(skills.names.length > 0 ? { names: skills.names } : {}),
  })

  let secretsKey: Buffer | null = null
  if (env.SECRETS_KEY) {
    try {
      secretsKey = masterKey(env.SECRETS_KEY)
      log.info('connector credentials can be decrypted')
    } catch (err) {
      // The message names a length, never a value (§2.3).
      log.error('SECRETS_KEY is set but unusable; connectors that need a credential will be skipped', {
        error: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY is not set — chat refuses turns; everything else still runs')
  }

  const server = createAgentHttpServer({
    port: env.AGENT_PORT,
    token: env.AGENT_INTERNAL_TOKEN,
    log,
    // The same implementation the health port serves, so the two can never
    // disagree about whether the runtime is halted.
    health: (url) => answerHealth(url, healthInputs()),
    probeConnector: async (orgId, connectorId) => {
      if (!env.ANTHROPIC_API_KEY) {
        return {
          ok: false,
          tools: [],
          message: 'The worker has no API key, so it cannot start a session to test with.',
        }
      }
      const row = await readConnector(db, orgId, connectorId)
      // Answered identically to a connector that does not exist. The id is the
      // only thing that crosses the boundary, so this is not a way to learn
      // that one belongs to somebody else.
      if (!row) return { ok: false, tools: [], message: 'That connector no longer exists.' }
      return probeConnector(db, row, secretsKey, env.ANTHROPIC_API_KEY, process.cwd(), log)
    },
    interrupt: (turnId) => {
      const turn = running.get(turnId)
      if (!turn) return false
      turn.interrupt()
      return true
    },
    startTurn: (req) =>
      beginTurn({ req, db, env, log, halt, running, secretsKey, skills }),
  })

  const apiPort = env.AGENT_PORT + 1
  await new Promise<void>((resolve) => server.listen(apiPort, env.AGENT_BIND, resolve))

  /**
   * Outreach (Phase 4, §8.4). Started AFTER the lock and the reconciler, like
   * the HTTP server: a second worker must never run a sender tick, and a tick
   * must never run before mid-send rows from the last worker have been
   * settled. Both halves are optional and independent — a mailbox that can
   * send but has no IMAP still sends, and is reported as 'send-only'.
   */
  const stops: Array<() => Promise<void>> = []
  if (env.SMTP_HOST && env.MAIL_FROM) {
    const provider = createSmtpProvider({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    })
    stops.push(startSender({ db, provider, log, batch: env.OUTREACH_BATCH, intervalMs: env.OUTREACH_TICK_MS }))
  }
  if (env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASSWORD) {
    stops.push(
      startInbox({
        db,
        log,
        config: {
          host: env.IMAP_HOST,
          port: env.IMAP_PORT,
          secure: env.IMAP_SECURE,
          user: env.IMAP_USER,
          password: env.IMAP_PASSWORD,
          mailbox: env.IMAP_MAILBOX,
        },
      }),
    )
  }

  log.info('agent worker started', {
    nodeEnv: env.NODE_ENV,
    healthPort: env.AGENT_PORT,
    apiPort,
    apiBind: env.AGENT_BIND,
    chat: env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled',
    outreach: outreachMode,
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
      // The sender first, and it waits for a tick in flight: a message half
      // way to the provider must finish or fail, never be abandoned as
      // `sending` for the next boot to write off.
      await Promise.all(stops.map((stop) => stop()))
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
  /** Resolved once at boot; null when SECRETS_KEY is unset or unusable. */
  secretsKey: Buffer | null
  /** Decided once at boot from what is on the skills volume (§6). */
  skills: { settingSources: readonly 'project'[]; skills?: 'all' }
}): Promise<{ ok: true; turn: TurnHandle } | { ok: false; status: number; message: string }> {
  const { req, db, env, log, halt, running, secretsKey, skills } = args

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
      secretsKey,
      turnTimeoutMs: env.AGENT_TURN_TIMEOUT_MINUTES * 60_000,
      skills,
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
      cancelPendingApprovals: async () => {
        const orphans = await cancelPendingApprovals(db, who.orgId, runtime.turnId)
        // §2.4's audit trail records the lapse, since the row itself cannot:
        // `approvals_reason_belongs_to_a_decision` forbids a reason on a row
        // nobody decided, which is the right constraint — this was not a
        // decision.
        for (const orphan of orphans) {
          await appendAudit(db, {
            orgId: who.orgId,
            actor: 'system',
            action: 'approval.cancelled',
            subjectType: 'approval',
            subjectId: orphan.id,
            detail: { toolName: orphan.toolName, turnId: runtime.turnId, why: 'the turn ended first' },
          }).catch(() => {
            // §5.4: the audit log remembers, but a failed insert must not stop
            // the work. The cancellation itself already landed.
          })
        }
        return orphans.map((o) => ({ id: o.id, toolName: o.toolName }))
      },
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

/** What the mailbox configuration adds up to, for the boot log and /readyz. */
function outreachModeFrom(env: ReturnType<typeof loadEnv>): HealthInputs['outreach'] {
  const send = Boolean(env.SMTP_HOST && env.MAIL_FROM)
  const receive = Boolean(env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASSWORD)
  if (send && receive) return 'send-and-receive'
  if (send) return 'send-only'
  if (receive) return 'receive-only'
  return 'disabled'
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
