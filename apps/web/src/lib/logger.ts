/**
 * Structured JSON logging with no dependencies (PROMPT.md §10).
 *
 * Never log credentials or full message bodies. `redact` exists so that a
 * value which might be a secret cannot be passed in by accident: it is applied
 * to every string field whose key looks sensitive.
 */
const SENSITIVE = /pass|secret|token|key|authorization|cookie|url$/i

type Fields = Record<string, unknown>

function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE.test(k) && typeof v === 'string' ? '[redacted]' : v
  }
  return out
}

function emit(level: string, msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    level,
    msg,
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
