/**
 * Does `cp .env.example .env` boot the worker and the voice service?
 *
 * The file is read the way `node --env-file` reads it — `util.parseEnv` IS
 * Node's own dotenv parser — with every commented-out `# NAME=` line
 * uncommented, so the blank values the file used to hide are present. Those
 * lines were commented out for one reason: a blank URL, uuid, enum or
 * length-checked secret stopped both processes booting. They must now boot
 * with every one of them blank, and every feature behind them off.
 *
 * The two secrets with no safe default are filled in, as the file says to:
 * compose refuses to start without either, and the worker refuses to boot
 * without `AGENT_INTERNAL_TOKEN` — that refusal is wanted.
 *
 * The web app's half is `apps/web/test/env.test.ts`, which reads a blank as
 * unset for each of its optional variables.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { loadEnv as loadAgentEnv } from '../src/env.js'
import { loadEnv as loadVoiceEnv, voiceMode } from '../../voice/src/env.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const example = readFileSync(resolve(root, '.env.example'), 'utf8')

/** A commented-out assignment with NO value: `# NAME=`. Prose that mentions `NAME=value` is left alone. */
const COMMENTED_BLANK = /^#\s*([A-Z][A-Z0-9_]*)=\s*$/

/** The lines `.env.example` commented out because a blank used to stop a process booting. */
const ONCE_HIDDEN = ['UNSUBSCRIBE_SECRET', 'WEB_PUBLIC_URL', 'LLM_PROVIDER', 'VOICE_PUBLIC_URL', 'VOICE_ORG_ID'] as const

function exampleWithEveryBlank(): Record<string, string> {
  const uncommented = example
    .split('\n')
    .map((line) => (COMMENTED_BLANK.test(line.trim()) ? line.trim().replace(/^#\s*/, '') : line))
    .join('\n')
  const parsed = parseEnv(uncommented)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined) out[k] = v
  return {
    ...out,
    // The two the file says to generate; blank, they refuse — as they should.
    AUTH_SECRET: 'a'.repeat(44),
    AGENT_INTERNAL_TOKEN: 'b'.repeat(44),
  }
}

describe('.env.example, with every blank present', () => {
  const vars = exampleWithEveryBlank()

  /** Not vacuous: each once-hidden variable is really in the replay, and really blank. */
  it.each(ONCE_HIDDEN)('carries %s as a blank value', (name) => {
    expect(vars[name]).toBe('')
  })

  it('boots the worker, with the features behind the blanks off', () => {
    const env = loadAgentEnv(vars as NodeJS.ProcessEnv)
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(env.WEB_PUBLIC_URL).toBeUndefined()
    expect(env.LLM_PROVIDER).toBeUndefined()
    expect(env.LLM_MODEL).toBeUndefined()
    expect(env.OUTREACH_BOUNCE_PAUSE_PCT).toBe(5)
  })

  it('boots the voice service, which still refuses every webhook', () => {
    const env = loadVoiceEnv(vars as NodeJS.ProcessEnv)
    expect(env.VOICE_PUBLIC_URL).toBeUndefined()
    expect(env.VOICE_ORG_ID).toBeUndefined()
    expect(env.LLM_PROVIDER).toBeUndefined()
    expect(voiceMode(env)).toBe('disabled')
  })

  /** Compose passes NODE_ENV=production to both. A blank is unset there too. */
  it('boots both in production', () => {
    const production = { ...vars, NODE_ENV: 'production', AGENT_USE_LOCAL_LOGIN: 'false' }
    expect(() => loadAgentEnv(production as NodeJS.ProcessEnv)).not.toThrow()
    expect(() => loadVoiceEnv(production as NodeJS.ProcessEnv)).not.toThrow()
  })
})
