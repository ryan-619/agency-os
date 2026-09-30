import { z } from 'zod'

/**
 * A blank value is UNSET — the web app's rule, and the worker's. `node
 * --env-file` reads `NAME=` as the empty string, and compose's `NAME:
 * ${NAME:-}` hands a variable nobody set to the container the same way, so a
 * blank URL, uuid or enum here stopped the service booting over a feature
 * nobody had turned on. Blank still means what unset means: with no
 * `VOICE_PUBLIC_URL` every webhook is refused.
 */
const blankIsUnset = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v)

/**
 * Validated at startup (PROMPT.md §10). Never logged.
 *
 * Most of this is OPTIONAL on purpose, the way the agent worker's mail
 * settings are: a voice service with no Twilio credentials boots, serves
 * health, and refuses every webhook — which is the correct behaviour for a
 * deployment whose A2P 10DLC registration has not cleared (§9, §12). What
 * it never does is answer or place a call it cannot verify came from Twilio.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(4),
  VOICE_PORT: z.coerce.number().int().positive().default(3003),
  /** Loopback by default; compose sets 0.0.0.0 (see the agent worker's AGENT_BIND). */
  VOICE_BIND: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * The origin Twilio reaches this service at — `https://voice.example.com`.
   * Signatures are computed over the URL TWILIO requested, and behind a
   * reverse proxy that is not the one the socket saw; and the TwiML has to
   * hand Twilio a `wss://` URL for the relay. Optional only so the process
   * can boot and report itself unconfigured on /readyz.
   */
  VOICE_PUBLIC_URL: z.preprocess(blankIsUnset, z.string().url().optional()),

  /** Twilio. Unset means every webhook is refused and nothing is dialled. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** The number calls and texts come from, E.164. */
  TWILIO_FROM_NUMBER: z.string().optional(),

  /**
   * Which org answers the phone. One org is seeded (§12), so this is
   * optional and the service uses the only org when exactly one exists;
   * with more than one it refuses to guess.
   */
  VOICE_ORG_ID: z.preprocess(blankIsUnset, z.string().uuid().optional()),

  /** Where a warm handoff goes: a TaskRouter workflow, or a person's number. */
  TASKROUTER_WORKFLOW_SID: z.string().optional(),
  VOICE_HANDOFF_NUMBER: z.string().optional(),
  /** The team member a handoff is recorded against (`calls.handoff_to_user_id`). */
  VOICE_HANDOFF_USER_EMAIL: z.preprocess(blankIsUnset, z.string().email().optional()),

  /**
   * The model behind the conversation. Optional: without it the scripted
   * policy runs — a complete, deterministic qualification that discloses,
   * asks three questions, and hands off — which is also what the tests
   * drive. With it, the model speaks and the same rules still apply
   * around it (opt-out and handoff are detected on the caller's words, not
   * left to the model).
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  VOICE_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  /** TTS/STT choices, passed through to `<ConversationRelay>`. */
  VOICE_LANGUAGE: z.string().default('en-US'),
  VOICE_TTS_PROVIDER: z.string().optional(),
  VOICE_TTS_VOICE: z.string().optional(),

  /**
   * The single-shot model for call summaries (§5.5).
   *
   * Unset means the deterministic extractive summary, which is what every
   * call gets today and is never worse than nothing. `ollama` keeps the
   * transcript on the agency's hardware, which §5.5 says is the point; the
   * remote ones additionally need LLM_ALLOW_REMOTE_LEAD_DATA, because a
   * call transcript is a named person's words.
   */
  LLM_PROVIDER: z.preprocess(blankIsUnset, z.enum(['ollama', 'openai', 'anthropic']).optional()),
  LLM_MODEL: z.preprocess(blankIsUnset, z.string().optional()),
  OLLAMA_BASE_URL: z.preprocess(blankIsUnset, z.string().url().default('http://127.0.0.1:11434')),
  /**
   * Declared, never inferred from the URL: an Ollama on a rented box is not
   * the agency's hardware, and guessing would turn §5.5's rule off for the
   * deployment that needs it most.
   */
  OLLAMA_IS_LOCAL: z
    .string()
    .optional()
    .transform((v) => v === undefined || !['false', '0', 'no'].includes(v.toLowerCase())),
  OPENAI_API_KEY: z.string().optional(),
  /**
   * Accepts that a call transcript may be sent to a third-party model.
   * Off unless somebody turned it on (§5.5).
   */
  LLM_ALLOW_REMOTE_LEAD_DATA: z
    .string()
    .optional()
    .transform((v) => v !== undefined && ['true', '1', 'yes'].includes(v.toLowerCase())),

  /** Hard ceiling on one call, in seconds. A stuck session ends. */
  VOICE_MAX_CALL_SECONDS: z.coerce.number().int().positive().default(900),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return parsed.data
}

/** What the service can do with what it was given — reported on /readyz. */
export function voiceMode(env: Env): 'disabled' | 'inbound' | 'inbound-and-outbound' {
  const twilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.VOICE_PUBLIC_URL)
  if (!twilio) return 'disabled'
  return env.TWILIO_FROM_NUMBER ? 'inbound-and-outbound' : 'inbound'
}
