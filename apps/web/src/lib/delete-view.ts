/**
 * Delete, on every screen that offers it (2026-10-15) — the half a browser
 * runs: which rows get a Delete button, what the confirm says before
 * anything is sent, what a refusal reads as, and what the pop-up says after.
 *
 * The rule is the database's (`packages/db/src/deletes.ts`): a delete
 * removes a record nothing outside the building ever depended on, and
 * refuses with a sentence naming the act that does apply — erase, withdraw,
 * cancel, move the deal, switch off. A button is offered only where that
 * writer could say yes from what the row shows; where it cannot be told from
 * the row (a contact who was written to, a campaign that sent), the button
 * is offered and the writer's sentence is the answer.
 *
 * Every pop-up here names the KIND of record and never the record: no
 * address, number, name or person's words — a toast is read over a
 * shoulder, and outlives the page in session storage (`toast.afterReload`).
 *
 * Pure and client-safe: no `server-only`, no `@/` import, no database. A
 * test imports it (`apps/web/test/delete-view.test.ts`).
 */

/** What a delete that did not happen says, and the writer's code when there is one. */
export interface DeleteFailure {
  readonly code: string
  readonly message: string
}

/** The kinds of record with a Delete button. */
export type DeleteKind =
  | 'contact'
  | 'company'
  | 'deal'
  | 'meeting'
  | 'proposal'
  | 'quote'
  | 'task'
  | 'campaign'
  | 'template'
  | 'icp'

/** How each is named in a sentence, with its article. */
const A: Readonly<Record<DeleteKind, string>> = {
  contact: 'a contact',
  company: 'a company',
  deal: 'a deal',
  meeting: 'a meeting',
  proposal: 'a proposal',
  quote: 'a quote',
  task: 'a task',
  campaign: 'a campaign',
  template: 'a template',
  icp: 'a profile',
}

/** The pop-up once the route has taken it. The kind, never the record. */
export const DELETED_WORDS: Readonly<Record<DeleteKind, string>> = {
  contact: 'Contact deleted.',
  company: 'Company deleted.',
  deal: 'Deal deleted. The company and its meetings stay.',
  meeting: 'Meeting deleted. The deal did not move back.',
  proposal: 'Draft proposal deleted.',
  quote: 'Draft quote deleted.',
  task: 'Task deleted.',
  campaign: 'Campaign deleted.',
  template: 'Template deleted.',
  icp: 'Profile deleted.',
}

/**
 * The route's words for a failure. A refusal is `{ error: code, message }`
 * (409, or 404 for one that is gone); a 401 or 403 carries a code alone; a
 * body that is not JSON, or a status nobody worded, gets a sentence that
 * says nothing was deleted.
 */
export function deleteFailureFrom(status: number, body: unknown, kind?: DeleteKind): DeleteFailure {
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = typeof b.error === 'string' && b.error.length <= 60 ? b.error : `http_${status}`
  if (typeof b.message === 'string' && b.message.trim()) return { code, message: b.message }
  if (status === 401) return { code, message: 'You are signed out. Sign in again; nothing was deleted.' }
  if (status === 403) {
    return { code, message: `Your role cannot delete ${kind ? A[kind].replace(/^an? /, 'this ') : 'this'}. Nothing was deleted.` }
  }
  if (status === 404) return { code, message: 'It is not there any more — it may already have been deleted. Reload the page.' }
  // A route's own sentence for anything else it answers, e.g. a 400.
  if (typeof b.error === 'string' && b.error.includes(' ')) return { code: `http_${status}`, message: b.error }
  return { code, message: 'That did not work, and nothing was deleted. Try again.' }
}

export type DeleteSent =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly failure: DeleteFailure }

/**
 * Ask a route to delete, and read its answer. `DELETE` with no body unless
 * one is given; `POST` for the two bulk routes, which take a list.
 */
export async function sendDelete(
  url: string,
  opts: { readonly method?: 'DELETE' | 'POST'; readonly body?: unknown; readonly kind?: DeleteKind } = {},
): Promise<DeleteSent> {
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'DELETE',
      ...(opts.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, failure: deleteFailureFrom(res.status, body, opts.kind) }
    return { ok: true, body: body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {} }
  } catch {
    return {
      ok: false,
      failure: {
        code: 'unreachable',
        message: 'The request did not complete. Reload the page to see whether it is still there before trying again.',
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Which rows get a Delete button
// ---------------------------------------------------------------------------

/** A won deal is the record of a sale; moving it off Won is the act. */
export const mayDeleteDeal = (stage: string): boolean => stage !== 'won'

/**
 * A meeting whose outcome is recorded stays; one with none — cancelled or
 * not — may go, unless it replaced a rescheduled meeting (`replacedOne`, the
 * page's `links.from`): the original points at it, and deleted it would
 * leave that one "rescheduled" to nothing. It is cancelled instead.
 */
export const mayDeleteMeeting = (outcome: string | null, replacedOne = false): boolean => outcome === null && !replacedOne

/** Only a draft: anything past it is withdrawn instead, and stays. */
export const mayDeleteProposal = (status: string): boolean => status === 'draft'

/**
 * Only a draft that never went out: one sent and then revised back to a
 * draft (`everSent` — a `quote.sent` row, or a link ever made for it) is a
 * number a buyer holds, and stays.
 */
export const mayDeleteQuote = (status: string, everSent = false): boolean => status === 'draft' && !everSent

/**
 * Not a LinkedIn step — closing one says whether a message went — and not a
 * done call that recorded "asked not to be called": that is where the
 * number's suppression came from.
 */
export function mayDeleteTask(t: { readonly kind: string; readonly doneAt: string | null; readonly outcome?: string | null }): boolean {
  if (t.kind === 'linkedin_send') return false
  return !(t.doneAt !== null && t.outcome === 'asked_to_stop')
}

/**
 * An ICP profile: the active one is never deleted (another is activated
 * first), and one a stored score names stays as that number's record.
 */
export function icpDeleteOffer(p: { readonly active: boolean; readonly scores: number }): 'delete' | 'active' | 'scored' {
  if (p.active) return 'active'
  return p.scores > 0 ? 'scored' : 'delete'
}

export const ICP_KEPT_WORDS: Readonly<Record<'active' | 'scored', string>> = {
  active: 'The active profile cannot be deleted. Activate another profile first.',
  scored: 'It cannot be deleted: scores were computed under it, and it stays as their record.',
}

// ---------------------------------------------------------------------------
// What the confirm says, before anything is sent
// ---------------------------------------------------------------------------

export const CONFIRM_WORDS = {
  contact: (name: string): string =>
    `Delete ${name}? They go for good, with the drafts waiting for them, their consents and the notes about them. ` +
    'Only somebody nothing ever went to or came from can be deleted — anybody else is kept, and an owner erases ' +
    'them instead, which keeps their addresses on the suppression list.',
  deal: (company: string): string =>
    `Delete the deal for ${company}? The company, its meetings, proposals and tasks stay — they lose the deal. ` +
    'A card on the wrong column is fixed by moving it, not by deleting it.',
  meeting:
    'Delete this meeting? It goes for good, and the deal does not move back — move it on the board if it should. ' +
    'Nobody is told: an invitation sent from a calendar is cancelled there.',
  proposal: 'Delete this draft proposal? It goes for good. A proposal that was sent is withdrawn instead, and stays.',
  quote:
    'Delete this draft quote? It goes for good, and the next quote raised this year may take its number — so if ' +
    'its Print/PDF went to a buyer, mark it sent and withdraw it instead. A sent quote is withdrawn instead, and stays.',
  task: 'Delete this task? It goes for good. A task that was carried out is ticked Done instead, which keeps it.',
  campaign: (name: string): string =>
    `Delete the campaign “${name}”? Its steps and the drafts waiting under it go with it. A campaign that sent ` +
    'anything is kept — set it to done instead.',
  template: (externalId: string): string =>
    `Delete template ${externalId}? A template any message was checked against is kept — switch it off instead.`,
  icp: (name: string): string => `Delete the profile “${name}”? It scored nothing, and nothing is judged by it.`,
  contacts: (n: number): string =>
    `Delete ${n === 1 ? 'this person' : `these ${n} people`}? Each goes for good, with the drafts waiting for them, ` +
    'their consents and the notes about them. Anybody something went to or came from, or who said no, is kept — ' +
    'the list afterwards says who, and why.',
} as const

/** What the companies' bulk bar says above the typed count. */
export function companiesBulkWords(n: number): string {
  return (
    `Deletes ${n === 1 ? 'this company' : `these ${n} companies`} with everything filed under each — its people, ` +
    'drafts, deals, meetings with no outcome, draft quotes and proposals, scans, notes, tasks, research and links. ' +
    'A company anything went to or came from is kept, and so is one with a won deal or a sent quote; the list ' +
    'afterwards says which, and why. It cannot be undone.'
  )
}

// ---------------------------------------------------------------------------
// Deleting a company: the name typed back
// ---------------------------------------------------------------------------

/** `noSiteDomain`'s placeholder (0022), restated so this file imports nothing. */
const NO_SITE = /\.nosite\.invalid$/i

/**
 * What a person types back to delete a company: its domain — the thing every
 * page names it by — or, for a business with no website, whose domain is a
 * placeholder nobody would recognise, its name.
 */
export function companyConfirmWord(c: { readonly domain: string; readonly name: string | null }): string {
  if (NO_SITE.test(c.domain) && c.name && c.name.trim()) return c.name.replace(/\s+/g, ' ').trim()
  return c.domain
}

/** Case and surrounding spaces do not matter; anything else does. */
export function companyConfirmMatches(typed: unknown, c: { readonly domain: string; readonly name: string | null }): boolean {
  if (typeof typed !== 'string') return false
  const fold = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return fold(typed) !== '' && fold(typed) === fold(companyConfirmWord(c))
}

/** The company page's danger panel: what goes, and what keeps a company on the record. */
export const COMPANY_DELETE_GOES = [
  'its people nothing went to or came from, and every draft that never went',
  'its deals, and meetings with no outcome recorded',
  'draft quotes and draft proposals',
  'its scans with their findings and scores, notes, tasks, research and site audits',
  'every link made for it — an audit page or a website preview already sent stops opening',
] as const

export const COMPANY_DELETE_KEEPS = [
  'anything sent to or received from it, or a call',
  'a call on /tasks where they asked to stop — where the suppression on their number came from',
  'a person there who said no, or whose own opt-out could not be recorded — an owner erases them first',
  'a person there holding a number a text asked to stop from, until the number is recorded on /suppressions',
  'a won deal',
  'a quote or proposal that left draft — a quote sent once and revised back to a draft included',
  'a meeting with its outcome recorded',
] as const

// ---------------------------------------------------------------------------
// Deleting several at once
// ---------------------------------------------------------------------------

/** The routes' own limits, restated for the bar: fifty companies, a hundred people. */
export const BULK_MAX: Readonly<Record<'companies' | 'contacts', number>> = { companies: 50, contacts: 100 }

/** A count typed back: the digits of the number selected, and nothing else. */
export function bulkConfirmMatches(typed: unknown, count: number): boolean {
  return typeof typed === 'string' && /^\d+$/.test(typed.trim()) && Number(typed.trim()) === count && count > 0
}

/** One row's answer from a bulk route. */
export interface BulkRowResult {
  readonly id: string
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
}

/** The answer's rows, each read defensively: anything malformed is a row that was not deleted. */
export function bulkResultsFrom(body: unknown): BulkRowResult[] {
  const rows = body !== null && typeof body === 'object' ? (body as { results?: unknown }).results : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((r): BulkRowResult[] => {
    if (r === null || typeof r !== 'object') return []
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string') return []
    return [{
      id: o.id,
      ok: o.ok === true,
      ...(typeof o.code === 'string' ? { code: o.code } : {}),
      ...(typeof o.message === 'string' ? { message: o.message } : {}),
    }]
  })
}

/** "3 deleted; 2 kept." — counts only, for the pop-up and the line above the list. */
export function bulkSummary(results: readonly BulkRowResult[], noun: { one: string; many: string }): string {
  const deleted = results.filter((r) => r.ok).length
  const kept = results.length - deleted
  const n = (k: number): string => `${k} ${k === 1 ? noun.one : noun.many}`
  if (kept === 0) return `${n(deleted)} deleted.`
  if (deleted === 0) return `Nothing deleted: ${n(kept)} kept.`
  return `${n(deleted)} deleted; ${kept} kept.`
}

/**
 * Kept rows grouped by what keeps them, so a list of thirty refusals reads
 * as three sentences with the names under each — the writer's sentence once.
 */
export function bulkKeptGroups(
  results: readonly BulkRowResult[],
  labelOf: (id: string) => string,
): { readonly message: string; readonly labels: readonly string[] }[] {
  const groups = new Map<string, string[]>()
  for (const r of results) {
    if (r.ok) continue
    const message = r.message ?? 'Not deleted.'
    const list = groups.get(message) ?? []
    list.push(labelOf(r.id))
    groups.set(message, list)
  }
  return [...groups].map(([message, labels]) => ({ message, labels }))
}
