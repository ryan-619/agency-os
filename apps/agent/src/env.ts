import { z } from 'zod'
import { isScannableHost } from '@agency/scanner'

/**
 * A blank value is UNSET, not a present value that happens to be empty — the
 * web app's rule (apps/web/src/lib/env.ts), now the worker's too.
 *
 * `node --env-file` reads `NAME=` as the empty string, and so does a compose
 * `NAME: ${NAME:-}` line for a variable the operator never set. Every feature
 * behind these variables fails closed when it is absent, so a blank one must
 * not stop the worker booting — and must not be READ as a value either: a
 * blank `LLM_MODEL` named the model `''`, and a blank
 * `OUTREACH_BOUNCE_PAUSE_PCT` coerced to 0, which paused a campaign on its
 * first bounce. A PRESENT value is still held to its shape.
 *
 * Every entry but the two required ones goes through it, not only those
 * whose blank used to refuse: a blank `IMAP_SECURE=` read as `false` —
 * plaintext — where an absent one reads as `true`, and a blank numeric
 * default coerced to 0 and was refused at boot. Blank takes the default,
 * everywhere; `test/env.test.ts` reads the names from this file and checks
 * each one. Every entry keeps `.optional()` or `.default(` on the line that
 * names it, because `packages/db/test/deployment.test.ts` reads this file
 * line by line to find the REQUIRED variables. DATABASE_URL and
 * AGENT_INTERNAL_TOKEN are not wrapped: a blank one is refused, and named.
 */
const blankIsUnset = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v)

/** Validated at startup, like the web app's (PROMPT.md §10). Never logged. */
const schema = z.object({
  NODE_ENV: z.preprocess(blankIsUnset, z.enum(['development', 'test', 'production']).default('development')),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AGENT_PORT: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(3001)),
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
  AGENT_BIND: z.preprocess(blankIsUnset, z.string().min(1).default('127.0.0.1')),
  LOG_LEVEL: z.preprocess(blankIsUnset, z.enum(['debug', 'info', 'warn', 'error']).default('info')),

  /**
   * The Agent SDK authenticates with an API key from the environment (§5).
   *
   * Still optional, and that is deliberate. The worker's other jobs — the
   * restart reconciler, the approval sweeper, health — are useful on their
   * own, and refusing to boot without a key would mean an unconfigured
   * deployment has no approval queue and no recovery either. Chat reports
   * `chat_disabled` instead, which is a sentence someone can act on.
   */
  ANTHROPIC_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * Needed only when ANTHROPIC_API_KEY is ORGANISATION-scoped.
   *
   * Such a key passes authentication and is then refused on every request,
   * `/v1/messages` included, with "This API key is not scoped to a workspace".
   * It arrives as a 400 rather than a 401, so it does not read as a
   * credential problem — the key looks broken when it is only unscoped.
   *
   * Prefer a WORKSPACE-SCOPED key and leave this unset: it needs no extra
   * configuration and the workspace can carry its own spend limit, which is
   * worth having when the balance is small.
   */
  ANTHROPIC_WORKSPACE_ID: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * Authenticate as the DEVELOPER, using their own Claude Code login (§13).
   *
   * The Agent SDK does not require an API key. Its own types name the other
   * sources — `apiKeySource: 'none'` is documented as "no API key in use -
   * e.g. claude.ai OAuth login", and `apiProvider: 'firstParty'` as the case
   * where "Anthropic OAuth login" applies. So a machine already logged into
   * Claude Code can run a real turn, and the gate that asked "is
   * ANTHROPIC_API_KEY set?" was answering a narrower question than the one it
   * meant: it conflated HAVING A KEY with BEING ABLE TO REACH A MODEL, which
   * were the same thing when it was written and are not.
   *
   * This is a DEVELOPMENT path and the schema says so rather than the docs:
   * `loadEnv` refuses it outright when NODE_ENV is production. The credential
   * belongs to a person, it lives in their OS keychain, there is no
   * interactive login on a server to create one, and a shared service
   * standing behind one human's account is what §2.3 exists to prevent.
   * Production authenticates with a key the deployment owns.
   */
  AGENT_USE_LOCAL_LOGIN: z.preprocess(blankIsUnset, z.string().optional()).transform(
    (v) => v !== undefined && ['true', '1', 'yes'].includes(v.toLowerCase()),
  ),

  /**
   * Where the Claude Code binary is, when it is not on PATH.
   *
   * The SDK ships no CLI — it drives one — and looks for `claude` on PATH.
   * A machine whose only copy arrived with the desktop app has it under
   * Application Support and nothing on PATH, and the resulting failure reads
   * like an auth problem rather than a missing file.
   */
  CLAUDE_CODE_PATH: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * Encrypts third-party connector credentials at rest (§2.3).
   *
   * Optional, because a deployment with no connectors configured needs no key
   * and must not be blocked from booting by one. A connector that HAS a
   * credential is skipped with a reason when this is unset, rather than
   * connecting unauthenticated and reporting an opaque 401.
   */
  SECRETS_KEY: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * Where the skills volume is mounted (§6). Unset means no skills.
   *
   * Loading skills means loading the project SETTING SOURCE — measured, not
   * assumed; see runtime/skills.ts — and a settings file in that source can
   * allow tool calls without the gate being consulted. So the worker refuses
   * to load skills from a directory that contains one, and a deployment that
   * does not use skills does not carry the setting source at all.
   */
  AGENT_SKILLS_DIR: z.preprocess(blankIsUnset, z.string().optional()),

  /** Overrides the SDK's default model per §5.5's "pick a model per task". */
  AGENT_MODEL: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * §5.5's single-shot seam, used here for reply triage (`classify_reply`).
   *
   * Unset means the deterministic kind `recordInboundReply` already stored,
   * which is a complete answer and never worse than nothing. `ollama` keeps
   * the reply on the agency's own hardware; the remote ones additionally
   * need LLM_ALLOW_REMOTE_LEAD_DATA, because a reply is a named person's
   * words.
   */
  LLM_PROVIDER: z.preprocess(blankIsUnset, z.enum(['ollama', 'openai', 'anthropic']).optional()),
  LLM_MODEL: z.preprocess(blankIsUnset, z.string().optional()),
  OLLAMA_BASE_URL: z.preprocess(blankIsUnset, z.string().url().default('http://127.0.0.1:11434')),
  /** Declared, never inferred from the URL — see packages/llm. */
  OLLAMA_IS_LOCAL: z.preprocess(blankIsUnset, z.string().optional()).transform(
    (v) => v === undefined || !['false', '0', 'no'].includes(v.toLowerCase()),
  ),
  OPENAI_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  LLM_ALLOW_REMOTE_LEAD_DATA: z.preprocess(blankIsUnset, z.string().optional()).transform(
    (v) => v !== undefined && ['true', '1', 'yes'].includes(v.toLowerCase()),
  ),

  /**
   * Proves the caller is the web app. Defence in depth, not the trust anchor:
   * the worker re-derives the principal from the database on every turn, so a
   * forged body can only address a conversation that already exists and
   * already belongs to the user it names.
   */
  AGENT_INTERNAL_TOKEN: z.string().min(32, 'AGENT_INTERNAL_TOKEN must be at least 32 characters'),

  /** §5.1's bounds on one turn. */
  AGENT_MAX_TURNS: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(30)),
  AGENT_MAX_BUDGET_USD: z.preprocess(blankIsUnset, z.coerce.number().positive().default(2)),

  /**
   * A bound the SDK does not provide. maxTurns and maxBudgetUsd bound ONE
   * turn, so twenty $2 turns in an hour sits inside every SDK limit.
   */
  AGENT_SESSION_BUDGET_USD: z.preprocess(blankIsUnset, z.coerce.number().positive().default(20)),

  /** §5.4's approval window. */
  APPROVAL_TTL_MINUTES: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(30)),
  APPROVAL_POLL_MS: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(2000)),
  APPROVAL_SWEEP_MS: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(60_000)),

  /**
   * The wall clock for one turn. Must EXCEED the approval window, or a turn
   * gets killed while its approval is still live and a human's decision lands
   * on a turn that no longer exists to consume it. Checked below.
   */
  AGENT_TURN_TIMEOUT_MINUTES: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(35)),

  /** Parked approvals must not starve the tool handlers sharing this pool. */
  DATABASE_POOL_MAX: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(8)),

  // --- outreach (Phase 4, §8.4) -------------------------------------------
  //
  // All optional, because a worker with no mailbox configured is a worker that
  // runs chat and scanning and sends nothing — which is a complete, honest
  // configuration and the one CI runs. `outreach: disabled` is logged at boot
  // and reported on /readyz so nobody wonders why a campaign is not moving.

  /** The mailbox that sends. The same SMTP_* the web app uses for magic links
   *  is the usual answer; a warmed outreach mailbox is the better one. */
  SMTP_HOST: z.preprocess(blankIsUnset, z.string().optional()),
  SMTP_PORT: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(587)),
  SMTP_USER: z.preprocess(blankIsUnset, z.string().optional()),
  SMTP_PASSWORD: z.preprocess(blankIsUnset, z.string().optional()),
  SMTP_SECURE: z.preprocess(blankIsUnset, z.string().optional()).transform(
    (v) => v === 'true' || v === '1',
  ),
  /** The From header on outreach. A display name and an address. */
  MAIL_FROM: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * The mailbox that RECEIVES replies (§8.4: "reply detection via IMAP IDLE").
   * Normally the same mailbox as SMTP_*, read back over IMAP. Unset means
   * replies are detected only through the inbound webhook, if one is wired.
   */
  IMAP_HOST: z.preprocess(blankIsUnset, z.string().optional()),
  IMAP_PORT: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(993)),
  IMAP_USER: z.preprocess(blankIsUnset, z.string().optional()),
  IMAP_PASSWORD: z.preprocess(blankIsUnset, z.string().optional()),
  IMAP_SECURE: z.preprocess(blankIsUnset, z.string().optional()).transform(
    (v) => v === undefined || v === 'true' || v === '1',
  ),
  IMAP_MAILBOX: z.preprocess(blankIsUnset, z.string().default('INBOX')),

  /** How often the sender looks for approved and queued messages. */
  OUTREACH_TICK_MS: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(15_000)),
  /** How many it will dispatch per tick, across every campaign. */
  OUTREACH_BATCH: z.preprocess(blankIsUnset, z.coerce.number().int().positive().default(20)),

  // The three below are read through `outreach/options.ts`, the one place the
  // sender's optional settings are derived from the environment. Every one of
  // them is optional or defaulted: unset, the sender behaves exactly as it did
  // before the variable existed. Every message here names a variable and
  // never its value (§2.3).

  /**
   * Signs the one-click unsubscribe token (RFC 8058) that rides in the
   * List-Unsubscribe headers of every outreach email. The SAME value as the
   * web app's, because the web app is what verifies the click. Either this or
   * WEB_PUBLIC_URL unset means no header, said once in the boot log — an
   * opt-out link nobody can verify is worse than none.
   */
  UNSUBSCRIBE_SECRET: z.preprocess(blankIsUnset, z.string().min(32, 'UNSUBSCRIBE_SECRET must be at least 32 characters').optional()),

  /**
   * The web app's public origin: the origin a recipient's mail client can
   * reach — where `/api/unsubscribe` lives, e.g. https://agency.example. The
   * header's link is built from this and nothing else: not the address the
   * worker binds, and not the compose service name, neither of which anybody
   * outside can reach. In production it must be `https:` on a public
   * multi-label host (checked in `loadEnv`): RFC 8058 one-click needs an
   * HTTPS URI, and mailbox providers ignore any other.
   */
  WEB_PUBLIC_URL: z.preprocess(blankIsUnset, z.string().url().optional()),

  /**
   * A campaign whose addresses bounce past this percentage pauses itself,
   * once it has been sent to at least twenty — below that the ratio is
   * noise. The existing `campaign_inactive` deferral is the stop; a person
   * re-activates it after fixing the list.
   */
  OUTREACH_BOUNCE_PAUSE_PCT: z.preprocess(blankIsUnset, z.coerce.number().min(0).max(100).default(5)),
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

  /**
   * The development-only credential, refused structurally rather than by
   * documentation (§2.1's habit applied to §2.3).
   *
   * A local login is one person's, held in their OS keychain, created by an
   * interactive flow no server has. A deployment authenticating as a human
   * means every turn the agency runs is billed to, rate-limited by, and
   * revocable with that person's account — and that no audit can tell the
   * service apart from them. Saying so in a comment invites somebody to set
   * it in production anyway; refusing to boot means they cannot.
   */
  if (env.AGENT_USE_LOCAL_LOGIN && env.NODE_ENV === 'production') {
    throw new Error(
      'AGENT_USE_LOCAL_LOGIN is a development path and must not be set in production. It ' +
        "authenticates as a PERSON, using their own Claude Code session: the credential is theirs, " +
        'it lives in their keychain, and a shared service standing behind it cannot be audited, ' +
        'billed or revoked separately from them (§2.3). Set ANTHROPIC_API_KEY instead.',
    )
  }

  /**
   * The one-click link must be one a recipient can press (RFC 8058 §3.1: an
   * HTTPS URI). `http://localhost:3000` or `http://web:3000` is a URL that
   * validates and that nobody outside can reach, and a header built on it is
   * the "worse than no link" case `outreach/options.ts` exists to prevent —
   * the person believes they asked. Refused at boot in production, naming
   * the variable and never its value; development may still point at
   * localhost, where the only recipient is the developer.
   */
  if (env.WEB_PUBLIC_URL !== undefined && env.NODE_ENV === 'production' && !isRecipientReachable(env.WEB_PUBLIC_URL)) {
    throw new Error(
      'WEB_PUBLIC_URL must be an https:// origin on a public multi-label host in production — the ' +
        "origin a recipient's mail client can reach. One-click unsubscribe (RFC 8058) needs an HTTPS " +
        'URI, and a loopback, an IP literal or a compose service name is a link nobody can press. ' +
        'Unset it to send without the header (said once at boot) until the web app has one.',
    )
  }

  return env
}

/**
 * `https:` on a public DNS name: at least one dot, no IP literal, no
 * `localhost`, no reserved or internal-use suffix — the scanner's own test
 * for a host out on the internet (`isScannableHost`), which is the same
 * question asked from the other side.
 */
function isRecipientReachable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'https:' && isScannableHost(url.hostname.toLowerCase())
}
