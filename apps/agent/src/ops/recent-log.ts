/**
 * The worker's recent warnings and errors, kept in memory for `recent_errors`
 * (packages/tools/src/ops.ts) — what an operator would otherwise have read
 * off a terminal, which this product deliberately does not have (§12).
 *
 * What is kept is a KIND, not a line: the message, the level, how many times
 * and when it was first and last seen — and the line's `error` field only
 * when it is an error CLASS (`TypeError`, `DoveSoftHttpError`) or an
 * upper-case CODE (`ENOTFOUND`). Every other field, and any other `error`, is
 * dropped as it arrives, because a field value can carry a touch id, an
 * address, a host or a reason (§2.3) — and what this keeps reaches a model's
 * context. Repeats of one (level, message, error) collapse into one entry
 * with a count, so a fault that fires every tick is one row with a number on
 * it, never two hundred rows that push everything else out.
 *
 * Bounded: at most `RECENT_LOG_CAPACITY` kinds, and the least recently seen
 * goes first. In memory only — a restart forgets it, as it forgets the
 * process that logged it — and never written anywhere.
 */
import type { OpsLogEntry } from '@agency/tools'
import type { Level, Logger } from '../logger.js'

/** The most kinds kept. Past it, the one seen least recently is forgotten. */
export const RECENT_LOG_CAPACITY = 200

/** A message is a literal a developer wrote; this bounds one that is not. */
const MESSAGE_MAX = 200

const ERROR_CLASS = /^[A-Z][A-Za-z0-9]*(Error|Exception)$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/

/** The `error` field as it may be kept — a class or a code — or undefined. */
export function keptError(value: unknown): string | undefined {
  return typeof value === 'string' && (ERROR_CLASS.test(value) || ERROR_CODE.test(value)) ? value : undefined
}

export interface RecentLog {
  /** Note one log line. Anything below warn is ignored. Never throws for a line it cannot read. */
  record(level: Level, msg: string, fields?: Record<string, unknown>): void
  /** Every kind kept, the most recently seen first. Copies: nothing a caller does changes the ring. */
  entries(): readonly OpsLogEntry[]
}

interface Entry {
  readonly level: 'warn' | 'error'
  readonly msg: string
  readonly error: string | undefined
  count: number
  readonly firstAt: Date
  lastAt: Date
}

export function createRecentLog(
  opts: { readonly capacity?: number; readonly now?: () => Date } = {},
): RecentLog {
  const capacity = Math.max(1, Math.floor(opts.capacity ?? RECENT_LOG_CAPACITY))
  const now = opts.now ?? (() => new Date())
  // Insertion order IS recency: a repeat is moved to the end, so the first
  // key is always the kind seen least recently.
  const kinds = new Map<string, Entry>()

  return {
    record(level, msg, fields) {
      if (level !== 'warn' && level !== 'error') return
      const message = typeof msg === 'string' ? bound(msg) : 'unreadable message'
      let error: string | undefined
      try {
        error = keptError(fields?.['error'])
      } catch {
        error = undefined
      }
      const key = `${level}\u0000${message}\u0000${error ?? ''}`
      const at = now()
      const seen = kinds.get(key)
      if (seen) {
        seen.count += 1
        seen.lastAt = at
        kinds.delete(key)
        kinds.set(key, seen)
        return
      }
      while (kinds.size >= capacity) {
        const oldest = kinds.keys().next()
        if (oldest.done) break
        kinds.delete(oldest.value)
      }
      kinds.set(key, { level, msg: message, error, count: 1, firstAt: at, lastAt: at })
    },
    entries() {
      return [...kinds.values()].reverse().map((e) => ({
        level: e.level,
        msg: e.msg,
        count: e.count,
        firstAt: new Date(e.firstAt.getTime()),
        lastAt: new Date(e.lastAt.getTime()),
        ...(e.error === undefined ? {} : { error: e.error }),
      }))
    },
  }
}

/** Cut by code points, so a cut never leaves half a character. */
function bound(msg: string): string {
  if (msg.length <= MESSAGE_MAX) return msg
  const chars = Array.from(msg)
  return chars.length <= MESSAGE_MAX ? msg : `${chars.slice(0, MESSAGE_MAX - 1).join('')}…`
}

/**
 * The worker's logger, with every warn and error line also noted in `recent`.
 *
 * A wrapper, not a change: each call reaches the logger it wraps exactly as
 * it was made, so every line the worker writes is the line it wrote before.
 * Noted whatever the logger's level floor — the ring answers "what went
 * wrong", which a LOG_LEVEL chosen for the terminal does not decide — and a
 * ring that threw would never cost a log line.
 */
export function recordingLogger(inner: Logger, recent: RecentLog): Logger {
  const tapped =
    (level: 'warn' | 'error') =>
    (msg: string, fields?: Record<string, unknown>): void => {
      inner[level](msg, fields)
      try {
        recent.record(level, msg, fields)
      } catch {
        // Never: `record` reads two values and drops the rest.
      }
    }
  return {
    debug: (msg, fields) => inner.debug(msg, fields),
    info: (msg, fields) => inner.info(msg, fields),
    warn: tapped('warn'),
    error: tapped('error'),
  }
}
