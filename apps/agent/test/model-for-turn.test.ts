/**
 * "Think harder" (2026-10-07): one chat turn runs on AGENT_DEEP_MODEL, every
 * other turn on AGENT_MODEL — the stronger model costs several times as much,
 * so it is never the default.
 */
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.js'
import { modelForTurn } from '../src/worker.js'

describe('modelForTurn', () => {
  it('runs an ordinary turn on AGENT_MODEL and a deep one on AGENT_DEEP_MODEL', () => {
    const env = { AGENT_MODEL: 'claude-haiku-4-5', AGENT_DEEP_MODEL: 'opus' }
    expect(modelForTurn(env, false)).toBe('claude-haiku-4-5')
    expect(modelForTurn(env, true)).toBe('opus')
  })

  it('defaults the deep model to Sonnet, and reads a blank as unset', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', AGENT_INTERNAL_TOKEN: 't'.repeat(40) }
    expect(loadEnv(base).AGENT_DEEP_MODEL).toBe('sonnet')
    expect(loadEnv({ ...base, AGENT_DEEP_MODEL: '' }).AGENT_DEEP_MODEL).toBe('sonnet')
    expect(loadEnv({ ...base, AGENT_DEEP_MODEL: 'opus' }).AGENT_DEEP_MODEL).toBe('opus')
  })
})
