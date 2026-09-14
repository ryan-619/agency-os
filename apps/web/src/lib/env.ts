import { z } from 'zod'

/**
 * Environment is a boundary, so it is validated with zod like every other
 * boundary (PROMPT.md §10). Failing at startup with a list of missing
 * variables beats failing on the first request with `undefined`.
 *
 * Nothing here is ever logged. Several of these values are credentials (§2.3).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
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
  AUTH_URL: z.string().min(1, 'AUTH_URL is required — Auth.js builds magic-link URLs from it'),

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
