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

  /** openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  AUTH_URL: z.string().min(1).default('http://localhost:3000'),
  AUTH_TRUST_HOST: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required to send magic links'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MAIL_FROM: z.string().min(1).default('Agency OS <agency-os@localhost>'),

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
