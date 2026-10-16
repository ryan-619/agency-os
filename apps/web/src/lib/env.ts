import { z } from 'zod'

/**
 * Environment is a boundary, so it is validated with zod like every other
 * boundary (PROMPT.md §10). Failing at startup with a list of missing
 * variables beats failing on the first request with `undefined`.
 *
 * Nothing here is ever logged. Several of these values are credentials (§2.3).
 */
/** Loopback and in-cluster names, where there is no public network to protect. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|db|postgres|host\.docker\.internal)$/i

/**
 * Does this connection string actually ask for TLS?
 *
 * The presence of `sslmode=` is not enough — `sslmode=disable` and an empty
 * `sslmode=` both parse as "present" while meaning the opposite. Only the
 * modes that encrypt count.
 */
function secureEnough(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL we can read. `getDb()` will fail loudly on it anyway, and
    // this refinement is not the place to invent a second error message.
    return true
  }
  if (LOCAL_HOST.test(parsed.hostname)) return true
  const mode = parsed.searchParams.get('sslmode')?.trim().toLowerCase()
  return mode === 'require' || mode === 'verify-ca' || mode === 'verify-full'
}

/**
 * A blank value is UNSET, not a present value that happens to be empty.
 *
 * `.env.example` documents every variable as `NAME=` at column 0, and
 * `cp .env.example .env` is the first command in CLAUDE.md. Every feature
 * behind one of these variables fails closed when it is absent — so a copied
 * file must not refuse to boot the whole app over a feature nobody has
 * turned on. A PRESENT value is still held to whatever the schema after it
 * demands: a short secret is a misconfiguration, and "fails closed" means
 * refusing it, not quietly accepting it.
 */
const blankIsUnset = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v)

/**
 * The one host a Slack incoming webhook lives on. Written out here so the
 * schema entry stays on one line: `packages/db/test/deployment.test.ts` reads
 * this file line by line to find the variables the app REQUIRES, and an entry
 * whose `.optional()` sits three lines down reads as one of them.
 */
const slackWebhookUrl = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'https:' && u.hostname === 'hooks.slack.com'
      } catch {
        return false
      }
    },
    'SLACK_WEBHOOK_URL must be an https://hooks.slack.com/… URL',
  )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * The connection string, which is also the ONLY thing deciding whether the
   * wire is encrypted.
   *
   * node-postgres sends no SSLRequest unless something sets `ssl`: pg's
   * defaults are `ssl: false`, it otherwise consults only `PGSSLMODE`, and
   * Vercel sets neither. Measured against the installed pg 8.16.3: with no
   * `sslmode` in the URL the client sends a plaintext StartupMessage carrying
   * the username and database in the clear, and the connection SUCCEEDS — so
   * a missing parameter is not an error anybody would notice. With
   * `sslmode=require` it sends the SSLRequest first and this pg version
   * treats `require` as `verify-full`.
   *
   * §2.3 is about credentials never being exposed, and a password negotiated
   * over a plaintext socket to a managed database on the public internet is
   * exposed. So the requirement is expressed here rather than left to
   * whoever pasted the URL, the way every other §2 rule is expressed in a
   * constraint instead of a convention.
   *
   * Keyed on the HOST, not on NODE_ENV: a loopback database (the PGlite
   * bridge, a local container) has no TLS and needs none, and refusing it
   * would just mean everyone develops with the check disabled.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => secureEnough(url),
      'DATABASE_URL points at a remote host with no TLS. Append ?sslmode=require ' +
        '(or sslmode=verify-full) — without it the driver negotiates the password over a ' +
        'plaintext socket and still connects, so nothing would tell you.',
    ),
  /** Connection pool ceiling. Lower it when Postgres is shared or constrained. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /** openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),

  /**
   * Required, with no default, on purpose.
   *
   * Auth.js reads `process.env.AUTH_URL` itself when it builds the magic-link
   * URL; it never sees a value parsed here. A zod `.default()` therefore made
   * the variable LOOK configured while Auth.js fell back to the request's
   * Host / X-Forwarded-Host header — which, with trustHost on, lets a
   * forged header decide the origin the sign-in link points at. Failing
   * loudly at startup is the only version of this that is honest.
   */
  AUTH_URL: z
    .string()
    .min(1, 'AUTH_URL is required — Auth.js builds magic-link URLs from it')
    /**
     * An ABSOLUTE http(s) origin, checked here even though nothing here uses
     * the parsed value.
     *
     * `.min(1)` alone accepted `myagencyos.in` — no scheme — which starts up
     * perfectly and then throws on every auth request, because Auth.js builds
     * the magic-link URL with `new URL()` and that is not a URL. The failure
     * lands on the sign-in page of a deployment that just passed its own
     * startup validation, which is the worst possible place to find out.
     *
     * Easy to get wrong precisely when it matters: the value changes on the
     * day a real domain is attached, typed by hand into a dashboard, by
     * somebody reading a runbook rather than this file.
     */
    .refine(
      (v) => {
        try {
          const u = new URL(v)
          return u.protocol === 'https:' || u.protocol === 'http:'
        } catch {
          return false
        }
      },
      'AUTH_URL must be an absolute URL including the scheme, e.g. https://myagencyos.in — ' +
        'Auth.js builds magic-link URLs from it with new URL(), so a bare hostname ' +
        'starts up fine and then fails on every sign-in attempt.',
    ),

  /**
   * Tri-state on purpose: `undefined` when unset, so Auth.js can apply its own
   * default. @auth/core assigns with `config.trustHost ??= ...`, so passing an
   * explicit `false` wins over that default and every request then fails with
   * UntrustedHost — including in development.
   */
  AUTH_TRUST_HOST: z
    .string()
    .optional()
    .transform((v) => (v && ['true', '1', 'yes'].includes(v.toLowerCase()) ? true : undefined)),

  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required to send magic links'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MAIL_FROM: z.string().min(1).default('Agency OS <agency-os@localhost>'),

  /**
   * The agent worker's internal API (PROMPT.md §3).
   *
   * The worker is a separate process so the web app never blocks on a turn —
   * and so the Agent SDK and ANTHROPIC_API_KEY stay out of the Next module
   * graph entirely. Nothing in apps/web imports the SDK, and CI builds this
   * app with no secrets on purpose to keep it that way.
   *
   * Optional: a deployment without an agent worker still has a working CRM,
   * and the chat panel says so rather than erroring.
   *
   * Read LOOSELY here, and validated by `agentConfigFrom` in
   * `lib/agent-config.ts`: this parse is all-or-nothing, and a malformed value
   * for this one chat-only variable made every page, the one-click
   * unsubscribe and every inbound webhook answer 500 (review round 15). A bad
   * value now turns chat off and is named on /settings/deployment.
   */
  AGENT_URL: z.preprocess(blankIsUnset, z.string().optional()),
  /**
   * Proves to the worker that this request came from the web app. It is NOT
   * what proves who the human is — the worker re-derives the principal from
   * the database — so the worst a stolen token does is let someone address a
   * conversation that already exists and already belongs to the user it names.
   * Its length is checked by `agentConfigFrom`, for the reason above.
   */
  AGENT_INTERNAL_TOKEN: z.preprocess(blankIsUnset, z.string().optional()),

  /**
   * Proves an inbound-email webhook (§8.4's "or the provider webhook") came
   * from the provider it was configured on. Unset means the route refuses
   * everything — a webhook with no secret is an endpoint that lets anyone on
   * the internet mark a contact as having replied, pause their sequence, and
   * put their address on the suppression list.
   */
  INBOUND_WEBHOOK_SECRET: z.preprocess(blankIsUnset, z.string().min(32).optional()),

  /**
   * Vercel sends it as `Authorization: Bearer <value>` on every cron GET.
   * Unset → every cron route answers 503. The routes also refuse to run
   * anywhere but production (see VERCEL_ENV below), so a preview deployment
   * that happens to inherit the secret does not rescan the pipeline.
   */
  CRON_SECRET: z.preprocess(blankIsUnset, z.string().min(32).optional()),
  /**
   * Companies per cron rescan run. Sequential, because DATABASE_POOL_MAX is 1
   * on Vercel; each scan can take around two minutes in the worst case under
   * a 300-second function ceiling, so the ceiling on this number is the
   * ceiling on the function.
   */
  RESCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(6),
  /**
   * A Slack incoming webhook. The URL IS the credential — never logged, never
   * in an audit row — and `redact()` cannot see it, because it matches on key
   * names and this one lives in a URL. Host-pinned: this variable makes the
   * web function POST to whatever it names, and a value pointing at the cloud
   * metadata endpoint would carry every notification there.
   */
  SLACK_WEBHOOK_URL: z.preprocess(blankIsUnset, slackWebhookUrl.optional()),
  /**
   * Signs one-click unsubscribe tokens. Unset → /api/unsubscribe answers 503
   * and the worker adds no List-Unsubscribe header. The SAME value on the
   * worker: a token this app cannot verify is a link that does nothing.
   */
  UNSUBSCRIBE_SECRET: z.preprocess(blankIsUnset, z.string().min(32).optional()),
  /**
   * Resend's endpoint signing secret (`whsec_…`). Unset → /api/inbound/resend
   * answers 503, like /api/inbound/email without its secret.
   */
  RESEND_WEBHOOK_SECRET: z.preprocess(blankIsUnset, z.string().min(16).optional()),
  /**
   * Resend API key, for the follow-up fetch of a received email's body. The
   * webhook carries only the envelope. Unset → /api/inbound/resend answers
   * 503 even with the signing secret set: a reply whose text cannot be read
   * cannot be classified, so nothing would be honest about it.
   */
  RESEND_API_KEY: z.preprocess(blankIsUnset, z.string().min(1).optional()),
  /**
   * Proves a DoveSoft delivery report or inbound text (`/api/inbound/dovesoft/
   * dlr` and `/sms`) came from the account it was registered on — as a
   * `token` query parameter, since DoveSoft may not send custom headers, or
   * `x-dovesoft-token`. A bearer credential: never logged, compared in
   * constant time. Unset → both routes answer 503: an unauthenticated inbound
   * text route would let anyone pause a contact or write a suppression.
   */
  DOVESOFT_WEBHOOK_SECRET: z.preprocess(blankIsUnset, z.string().min(32).optional()),
  /**
   * The org this deployment's DoveSoft account belongs to, as `VOICE_ORG_ID`
   * names it for calls. A text from a number no contact holds, and a report
   * naming a message nobody sent, are audited in it — and an opt-out from an
   * unknown number is suppressed in it. Unset → those are logged, not filed.
   */
  DOVESOFT_ORG_ID: z.preprocess(blankIsUnset, z.uuid().optional()),
  /**
   * Documented here so `.env.example` and this schema agree; READ by
   * `secretsKeyFromEnv()` in packages/db, which reports a malformed key as
   * unset and says why. Nothing in this app reads the parsed value.
   */
  SECRETS_KEY: z.string().optional(),
  /**
   * Set by the platform on Vercel. Read HERE, never from process.env in a
   * route: the cron routes refuse to run anywhere but production. Unset
   * locally, and never set by hand.
   */
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Env = z.infer<typeof schema>

/**
 * What `env()` throws. Its NAME is what /api/health reports, so a deployment
 * whose configuration does not parse says `config: invalid` rather than
 * `database: unreachable` — the health check blamed the database for a
 * malformed AGENT_URL, which pointed the person reading it the wrong way
 * (review round 15). The message lists the failing variables by name, never
 * a value, and reaches the platform's log only.
 */
export class InvalidEnvironmentError extends Error {
  override readonly name = 'InvalidEnvironmentError'
  readonly variables: readonly string[]
  constructor(variables: readonly string[], problems: string) {
    super(`Invalid environment configuration:\n${problems}`)
    this.variables = variables
  }
}

function load(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    // Print the variable NAMES that failed, never their values.
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    const variables = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))]
    throw new InvalidEnvironmentError(variables, problems)
  }
  return parsed.data
}

let cached: Env | null = null

/** Validated environment. Throws on first access if anything is missing. */
export function env(): Env {
  cached ??= load()
  return cached
}
