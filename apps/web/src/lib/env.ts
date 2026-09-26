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
   */
  AGENT_URL: z.string().url().optional(),
  /**
   * Proves to the worker that this request came from the web app. It is NOT
   * what proves who the human is — the worker re-derives the principal from
   * the database — so the worst a stolen token does is let someone address a
   * conversation that already exists and already belongs to the user it names.
   */
  AGENT_INTERNAL_TOKEN: z.string().min(32).optional(),

  /**
   * Proves an inbound-email webhook (§8.4's "or the provider webhook") came
   * from the provider it was configured on. Unset means the route refuses
   * everything — a webhook with no secret is an endpoint that lets anyone on
   * the internet mark a contact as having replied, pause their sequence, and
   * put their address on the suppression list.
   */
  INBOUND_WEBHOOK_SECRET: z.string().min(32).optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Env = z.infer<typeof schema>

function load(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    // Print the variable NAMES that failed, never their values.
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return parsed.data
}

let cached: Env | null = null

/** Validated environment. Throws on first access if anything is missing. */
export function env(): Env {
  cached ??= load()
  return cached
}
