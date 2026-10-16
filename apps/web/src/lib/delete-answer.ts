import { and, eq } from 'drizzle-orm'
import { companyDelete, schema, type AgencyDb } from '@agency/db/queries'
import { companyConfirmMatches, companyConfirmWord, type DeleteKind } from './delete-view'

/**
 * Every delete route's answer, everything but the session and the id
 * (2026-10-15): the one writer call each makes, and what its answer — or a
 * database fault under it — becomes on the wire.
 *
 *  - a delete that happened is 200, `{ deleted: true, …what went }`;
 *  - a refusal is 409 `{ error: <code>, message }` — the writer's sentence,
 *    which names the act that does apply — and one for a record that is not
 *    there (another org's id included) is 404, the same shape;
 *  - a fault is 500 with a sentence, and ONE log line naming the fault's
 *    CLASS: drizzle's message lists every bound parameter, and Next
 *    `console.error`s an escaping error whole, past `redact()` (the
 *    templates routes' rule, `app/api/templates/outcome.ts`). Each writer is
 *    one transaction, so a fault leaves nothing half-deleted.
 *
 * The two bulk routes take a list and run each id through its writer in a
 * transaction of its own, so one person kept never keeps the rest, and
 * answer `{ results: [{ id, ok, code?, message? }] }` with 200 whatever each
 * row's answer was — the rows say.
 *
 * Kept with no `server-only` and no `@/` import, so
 * `apps/web/test/delete-routes.test.ts` runs the routes' own calls against a
 * real database, and against one that fails.
 */

export interface WireAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface DeleteLog {
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * What every writer in `deletes.ts` answers: a success, carrying what went
 * (counts and ids, which the wire passes on), or a refusal with a code and a
 * sentence.
 */
export type DeleteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** How a kind is named in the fault sentence and the log line. */
const NOUN: Readonly<Record<DeleteKind, string>> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  meeting: 'meeting',
  proposal: 'proposal',
  quote: 'quote',
  task: 'task',
  campaign: 'campaign',
  template: 'template',
  icp: 'profile',
}

const faultClass = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError')

/** A delete that faulted: one transaction each, so nothing was deleted. */
export function deleteFaultSentence(kind: DeleteKind): string {
  return `The ${NOUN[kind]} could not be deleted because the database did not answer. Nothing was deleted — try again.`
}

/** A refusal or a success, as the wire carries it. */
function answerOf(r: DeleteOutcome): WireAnswer {
  if (r.ok) {
    const { ok: _ok, ...rest } = r
    return { status: 200, body: { deleted: true, ...rest } }
  }
  return { status: r.code === 'not_found' ? 404 : 409, body: { error: r.code, message: r.message } }
}

/** `DELETE /api/<kind>/[id]`: one writer call, its answer, or a caught fault. */
export async function deleteAnswer(kind: DeleteKind, run: () => Promise<DeleteOutcome>, log: DeleteLog): Promise<WireAnswer> {
  try {
    return answerOf(await run())
  } catch (err) {
    log.error(`${NOUN[kind]} could not be deleted`, { error: faultClass(err) })
    return { status: 500, body: { error: 'database_fault', message: deleteFaultSentence(kind) } }
  }
}

/** A refusal before the writer runs: a request that cannot be read is 400, the same shape as a refusal. */
export const badRequest = (code: string, message: string): WireAnswer => ({ status: 400, body: { error: code, message } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A JSON body a delete route reads: a few kilobytes at most — a hundred ids is under four. */
export const DELETE_MAX_REQUEST_BYTES = 16_384

/** The text of a body as JSON, or a 400/413 to answer with. An empty body is `{}`. */
export function readDeleteBody(raw: string): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly answer: WireAnswer } {
  if (raw.length > DELETE_MAX_REQUEST_BYTES) {
    return { ok: false, answer: { status: 413, body: { error: 'too_large', message: 'That request is too large. Nothing was deleted.' } } }
  }
  if (raw.trim() === '') return { ok: true, body: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, answer: badRequest('invalid_json', 'That request could not be read. Nothing was deleted.') }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, answer: badRequest('invalid_json', 'That request could not be read. Nothing was deleted.') }
  }
}

/**
 * A bulk request's ids: a list of one to `max` ids, each in a uuid's full
 * shape, read once each in the order given. With `confirmCount`, the body's
 * `confirm` must be that count typed as digits — the companies' bulk delete,
 * which is an owner's and takes everything filed under each.
 */
export function parseBulkDelete(
  body: Record<string, unknown>,
  opts: { readonly max: number; readonly confirmCount: boolean; readonly noun: string },
): { readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false; readonly answer: WireAnswer } {
  const raw = body.ids
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, answer: badRequest('no_ids', `Choose at least one ${opts.noun} to delete. Nothing was deleted.`) }
  }
  if (raw.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    return { ok: false, answer: badRequest('bad_id', 'One of the chosen rows could not be read. Reload the page and choose again. Nothing was deleted.') }
  }
  const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]
  if (ids.length > opts.max) {
    return {
      ok: false,
      answer: badRequest('too_many', `At most ${opts.max} at a time — ${ids.length} were chosen. Nothing was deleted.`),
    }
  }
  if (opts.confirmCount) {
    const typed = typeof body.confirm === 'string' ? body.confirm.trim() : ''
    if (!/^\d+$/.test(typed) || Number(typed) !== ids.length) {
      return {
        ok: false,
        answer: badRequest('confirm', `Type ${ids.length}, the number chosen, to confirm. Nothing was deleted.`),
      }
    }
  }
  return { ok: true, ids }
}

/**
 * `POST /api/<kind>s/delete`: each id through its writer, one transaction
 * each and one after another — never in parallel, because a company's
 * writer locks its people and two of them at once would race for nothing.
 * A fault on one row is that row's answer; the rest are still asked. The
 * log carries the count of faults and their class, once.
 */
export async function bulkDeleteAnswer(
  kind: DeleteKind,
  ids: readonly string[],
  run: (id: string) => Promise<DeleteOutcome>,
  log: DeleteLog,
): Promise<WireAnswer> {
  const results: Record<string, unknown>[] = []
  let faults = 0
  let lastFault = ''
  for (const id of ids) {
    try {
      const r = await run(id)
      results.push(r.ok ? { id, ok: true } : { id, ok: false, code: r.code, message: r.message })
    } catch (err) {
      faults += 1
      lastFault = faultClass(err)
      results.push({ id, ok: false, code: 'database_fault', message: deleteFaultSentence(kind) })
    }
  }
  if (faults > 0) log.error(`${NOUN[kind]} delete faulted`, { error: lastFault, faults, of: ids.length })
  return { status: 200, body: { results } }
}

/**
 * `DELETE /api/companies/[id]` — an owner's, with the company's domain (a
 * no-website business's name) typed back, as an erasure takes the contact's
 * id. The company is read in this org first to know what to compare; the
 * writer then locks and decides on its own. A missing company is the
 * writer's 404, whatever was typed — nothing here says another org's id
 * exists.
 */
export async function companyDeleteAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly companyId: string; readonly confirm: unknown; readonly actor: string },
  log: DeleteLog,
): Promise<WireAnswer> {
  let company: { readonly domain: string; readonly name: string | null } | undefined
  try {
    ;[company] = await db
      .select({ domain: schema.companies.domain, name: schema.companies.name })
      .from(schema.companies)
      .where(and(eq(schema.companies.orgId, args.orgId), eq(schema.companies.id, args.companyId)))
      .limit(1)
  } catch (err) {
    log.error('company could not be deleted', { error: faultClass(err) })
    return { status: 500, body: { error: 'database_fault', message: deleteFaultSentence('company') } }
  }
  if (company && !companyConfirmMatches(args.confirm, company)) {
    return badRequest('confirm', `Type ${companyConfirmWord(company)} exactly to confirm. Nothing was deleted.`)
  }
  return deleteAnswer(
    'company',
    () => companyDelete(db, { orgId: args.orgId, companyId: args.companyId, actor: args.actor }),
    log,
  )
}
