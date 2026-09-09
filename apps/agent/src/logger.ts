import { redact } from '@agency/core'

/**
 * Structured JSON logging (PROMPT.md §10). Never log credentials or full
 * message bodies. Redaction lives in packages/core so this and the web app
 * cannot drift apart; see packages/core/src/redact.ts.
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
      service: 'agent',
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
