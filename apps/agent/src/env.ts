import { z } from 'zod'

/** Validated at startup, like the web app's (PROMPT.md §10). Never logged. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AGENT_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * What the internal API binds to. Loopback by default, which is right when
   * the worker and the web app share a host.
   *
   * It is WRONG under compose, and silently so: each service has its own
   * network namespace, so a worker bound to 127.0.0.1 is reachable from
   * nothing but itself — the web container's request to `http://agent:3002`
   * is refused, and chat reports the worker as unreachable while the worker's
   * own logs say it started fine. Compose sets this to 0.0.0.0 and does NOT
   * publish the port, so the docker network is the boundary instead of the
   * bind address.
   */
  AGENT_BIND: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * The Agent SDK authenticates with an API key from the environment (§5).
   *
   * Still optional, and that is deliberate. The worker's other jobs — the
   * restart reconciler, the approval sweeper, health — are useful on their
   * own, and refusing to boot without a key would mean an unconfigured
   * deployment has no approval queue and no recovery either. Chat reports
   * `chat_disabled` instead, which is a sentence someone can act on.
   */
  ANTHROPIC_API_KEY: z.string().optional(),

  /**
   * Encrypts third-party connector credentials at rest (§2.3).
   *
   * Optional, because a deployment with no connectors configured needs no key
   * and must not be blocked from booting by one. A connector that HAS a
   * credential is skipped with a reason when this is unset, rather than
   * connecting unauthenticated and reporting an opaque 401.
   */
  SECRETS_KEY: z.string().optional(),

  /**
   * Where the skills volume is mounted (§6). Unset means no skills.
   *
   * Loading skills means loading the project SETTING SOURCE — measured, not
   * assumed; see runtime/skills.ts — and a settings file in that source can
   * allow tool calls without the gate being consulted. So the worker refuses
   * to load skills from a directory that contains one, and a deployment that
   * does not use skills does not carry the setting source at all.
   */
  AGENT_SKILLS_DIR: z.string().optional(),

  /** Overrides the SDK's default model per §5.5's "pick a model per task". */
  AGENT_MODEL: z.string().optional(),

  /**
   * Proves the caller is the web app. Defence in depth, not the trust anchor:
   * the worker re-derives the principal from the database on every turn, so a
   * forged body can only address a conversation that already exists and
   * already belongs to the user it names.
   */
  AGENT_INTERNAL_TOKEN: z.string().min(32, 'AGENT_INTERNAL_TOKEN must be at least 32 characters'),

  /** §5.1's bounds on one turn. */
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(30),
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(2),

  /**
   * A bound the SDK does not provide. maxTurns and maxBudgetUsd bound ONE
   * turn, so twenty $2 turns in an hour sits inside every SDK limit.
   */
  AGENT_SESSION_BUDGET_USD: z.coerce.number().positive().default(20),

  /** §5.4's approval window. */
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  APPROVAL_POLL_MS: z.coerce.number().int().positive().default(2000),
  APPROVAL_SWEEP_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * The wall clock for one turn. Must EXCEED the approval window, or a turn
   * gets killed while its approval is still live and a human's decision lands
   * on a turn that no longer exists to consume it. Checked below.
   */
  AGENT_TURN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(35),

  /** Parked approvals must not starve the tool handlers sharing this pool. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(8),

  // --- outreach (Phase 4, §8.4) -------------------------------------------
  //
  // All optional, because a worker with no mailbox configured is a worker that
  // runs chat and scanning and sends nothing — which is a complete, honest
  // configuration and the one CI runs. `outreach: disabled` is logged at boot
  // and reported on /readyz so nobody wonders why a campaign is not moving.

  /** The mailbox that sends. The same SMTP_* the web app uses for magic links
   *  is the usual answer; a warmed outreach mailbox is the better one. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** The From header on outreach. A display name and an address. */
  MAIL_FROM: z.string().optional(),

  /**
   * The mailbox that RECEIVES replies (§8.4: "reply detection via IMAP IDLE").
   * Normally the same mailbox as SMTP_*, read back over IMAP. Unset means
   * replies are detected only through the inbound webhook, if one is wired.
   */
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  IMAP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
  IMAP_MAILBOX: z.string().default('INBOX'),

  /** How often the sender looks for approved and queued messages. */
  OUTREACH_TICK_MS: z.coerce.number().int().positive().default(15_000),
  /** How many it will dispatch per tick, across every campaign. */
  OUTREACH_BATCH: z.coerce.number().int().positive().default(20),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  const env = parsed.data

  // A boot refusal rather than a comment. Getting this ordering wrong produces
  // the confusing failure — a turn aborted at 20 minutes while its approval
  // card says 10 minutes left, and a human clicking Approve into nothing.
  //
  // It is NECESSARY and NOT SUFFICIENT, because the two clocks start at
  // different moments: the turn's at the question, the approval's whenever the
  // model gets round to asking. An approval raised ten minutes into a
  // 35-minute turn with a 30-minute TTL still expires at minute 40. What
  // actually makes the card's countdown true is the clamp in the gate
  // (`turnDeadline`); this check keeps the configuration sane so that clamp is
  // rarely the thing doing the work.
  if (env.AGENT_TURN_TIMEOUT_MINUTES <= env.APPROVAL_TTL_MINUTES) {
    throw new Error(
      `AGENT_TURN_TIMEOUT_MINUTES (${env.AGENT_TURN_TIMEOUT_MINUTES}) must be greater than ` +
        `APPROVAL_TTL_MINUTES (${env.APPROVAL_TTL_MINUTES}), or a turn is killed while its own ` +
        'approval is still live and the decision has nothing left to resume.',
    )
  }

  return env
}
