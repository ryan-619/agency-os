import { redact } from '@agency/core'

/**
 * Structured JSON logging (PROMPT.md §10), the agent worker's logger with
 * `service: 'voice'`. Never a credential, never a transcript line: what a
 * caller said is written to `calls.transcript` by the session, and a log is
 * not a second copy of it.
 */
type Fields = Record<string, unknown>

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

export function createLogger(minLevel: Level = 'info', base: Fields = {}) {
  const floor = LEVELS[minLevel]
  const emit = (level: Level, msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < floor) return
    const line = JSON.stringify({
      level,
      msg,
      service: 'voice',
      time: new Date().toISOString(),
      ...base,
      ...redact(fields),
    })
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }
  return {
    debug: (m: string, f?: Fields) => emit('debug', m, f),
    info: (m: string, f?: Fields) => emit('info', m, f),
    warn: (m: string, f?: Fields) => emit('warn', m, f),
    error: (m: string, f?: Fields) => emit('error', m, f),
  }
}

export type Logger = ReturnType<typeof createLogger>
