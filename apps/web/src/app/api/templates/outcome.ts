import { templatesCreate, templatesImportDltCsv, type AgencyDb } from '@agency/db/queries'
import { TEMPLATE_REFUSAL_STATUS, templateView, type TemplateCreateInput } from './rules'

/**
 * `POST /api/templates` and `POST /api/templates/import`, everything but the
 * session and the body's bytes (0019): the one call each makes, and what its
 * answer — or a database fault under it — becomes on the wire.
 *
 * Kept beside the routes, with no `server-only` and no `@/` import, so
 * `apps/web/test/templates-route.test.ts` runs the routes' own call against
 * a real database, and against one that fails.
 *
 * A fault is caught HERE and answered 500 with a sentence, with one log line
 * naming the fault's CLASS (review round 9). It escaped both routes whole:
 * Next `console.error`s an escaping error past `redact()`, and drizzle's
 * message lists every bound parameter — the template's words, its ids and
 * the org's. `templatesCreate` and the import refuse what would not store
 * (a U+0000 among it) with a sentence of their own, so a fault here is the
 * database's, not the input's.
 */

export interface WireAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface TemplatesLog {
  error(message: string, fields?: Record<string, unknown>): void
}

/** A create that faulted: `templatesCreate` writes one row, so nothing was recorded. */
export const TEMPLATE_CREATE_FAULT =
  'The template could not be recorded because the database did not answer. Nothing was recorded — try again.'

/**
 * An import that faulted. Lines are recorded one at a time, so the ones
 * before the fault may be stored — and a re-import of the same file reports
 * each of those as already present, never records it twice.
 */
export const TEMPLATE_IMPORT_FAULT =
  'The import stopped because the database did not answer, and templates on the lines before the one it stopped ' +
  'at may already be recorded. Import the same file again: a template already recorded is reported as already ' +
  'present, never recorded twice.'

const faultClass = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError')

/** POST /api/templates: one template, as the portal registered it. */
export async function templateCreateAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly input: TemplateCreateInput; readonly createdBy: string },
  log: TemplatesLog,
): Promise<WireAnswer> {
  try {
    const r = await templatesCreate(db, args.orgId, { ...args.input, createdBy: args.createdBy })
    if (!r.ok) return { status: TEMPLATE_REFUSAL_STATUS[r.reason], body: { error: r.message, reason: r.reason } }
    return { status: 201, body: { template: templateView(r.template) } }
  } catch (err) {
    log.error('template could not be recorded', { error: faultClass(err) })
    return { status: 500, body: { error: TEMPLATE_CREATE_FAULT } }
  }
}

/** POST /api/templates/import: the export, already read as strict UTF-8. */
export async function templateImportAnswer(
  db: AgencyDb,
  args: { readonly orgId: string; readonly text: string; readonly createdBy: string },
  log: TemplatesLog,
): Promise<WireAnswer> {
  try {
    const r = await templatesImportDltCsv(db, args.orgId, args.text, { createdBy: args.createdBy })
    if (!r.ok) return { status: 400, body: { error: r.message } }
    return {
      status: 200,
      body: {
        imported: r.imported,
        alreadyPresent: r.alreadyPresent,
        skipped: r.skipped,
        refused: r.refused,
        lines: r.lines,
      },
    }
  } catch (err) {
    log.error('template import could not be completed', { error: faultClass(err) })
    return { status: 500, body: { error: TEMPLATE_IMPORT_FAULT } }
  }
}
