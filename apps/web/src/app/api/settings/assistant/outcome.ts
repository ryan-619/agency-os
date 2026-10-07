import { requestBrief, saveBrief, savePlaybook, type AgencyDb } from '@agency/db/queries'

/**
 * The three writes Settings → Assistant makes (0020), everything but the
 * session and the body's bytes: the one call each makes, and what its answer
 * — or a database fault under it — becomes on the wire.
 *
 * Kept beside the routes, with no `server-only` and no `@/` import, so
 * `apps/web/test/assistant-settings.test.ts` runs them against a real
 * database, and against one that fails.
 *
 * A fault is caught HERE and answered 500 with a sentence, with one log line
 * naming its CLASS: drizzle's message quotes every bound parameter — the
 * playbook's words among them — and Next `console.error`s an escaping error
 * whole, past `redact()`. Each write is one transaction with its audit row,
 * so a fault means nothing changed.
 */

export interface WireAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface AssistantLog {
  error(message: string, fields?: Record<string, unknown>): void
}

export const ASSISTANT_SAVE_FAULT =
  'That could not be saved because the database did not answer. Nothing was changed — try again.'

const faultClass = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError')

/** PUT /api/settings/assistant/playbook */
export async function playbookAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string; readonly playbook: string },
  log: AssistantLog,
): Promise<WireAnswer> {
  try {
    const r = await savePlaybook(db, args)
    if (!r.ok) return { status: 400, body: { error: r.message, reason: r.reason } }
    return { status: 200, body: { ok: true, chars: r.chars } }
  } catch (err) {
    log.error('the playbook could not be saved', { error: faultClass(err) })
    return { status: 500, body: { error: ASSISTANT_SAVE_FAULT } }
  }
}

/** PUT /api/settings/assistant/brief */
export async function briefAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string; readonly enabled: boolean; readonly at: string; readonly timeZone: string },
  log: AssistantLog,
): Promise<WireAnswer> {
  try {
    const r = await saveBrief(db, args)
    if (!r.ok) return { status: 400, body: { error: r.message, reason: r.reason } }
    return { status: 200, body: { ok: true } }
  } catch (err) {
    log.error('the morning brief could not be saved', { error: faultClass(err) })
    return { status: 500, body: { error: ASSISTANT_SAVE_FAULT } }
  }
}

/** POST /api/settings/assistant/brief/run: "Run it now". */
export async function briefRunAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string },
  log: AssistantLog,
): Promise<WireAnswer> {
  try {
    const r = await requestBrief(db, args)
    if (!r.ok) return { status: 409, body: { error: r.message, reason: r.reason } }
    return { status: 202, body: { ok: true } }
  } catch (err) {
    log.error('a morning brief could not be requested', { error: faultClass(err) })
    return { status: 500, body: { error: ASSISTANT_SAVE_FAULT } }
  }
}
