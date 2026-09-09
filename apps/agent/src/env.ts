import { z } from 'zod'

/** Validated at startup, like the web app's (PROMPT.md §10). Never logged. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AGENT_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * The Agent SDK authenticates with an API key from the environment (§5).
   * Optional in Phase 0 — the query() loop lands in Phase 2 — so that the
   * worker still boots and reports health without one.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof schema>

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return parsed.data
}
