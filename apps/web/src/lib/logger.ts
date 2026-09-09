import { redact } from '@agency/core'

/**
 * Structured JSON logging with no dependencies beyond the domain package
 * (PROMPT.md §10). Never log credentials or full message bodies.
 *
 * Redaction lives in packages/core so the web app and the agent worker cannot
 * drift apart on it. See packages/core/src/redact.ts for what it does and does
 * not catch.
 */
type Fields = Record<string, unknown>

function emit(level: string, msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    level,
    msg,
    service: 'web',
    time: new Date().toISOString(),
    ...redact(fields),
  })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const log = {
  debug: (msg: string, f?: Fields) => emit('debug', msg, f),
  info: (msg: string, f?: Fields) => emit('info', msg, f),
  warn: (msg: string, f?: Fields) => emit('warn', msg, f),
  error: (msg: string, f?: Fields) => emit('error', msg, f),
}
