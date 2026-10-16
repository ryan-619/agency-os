/**
 * The night shift (0025): once a night, in the agency's own zone, run the
 * org's saved Google Maps searches, file the new businesses, scan and measure
 * the sites among them, and leave a ranked list for the morning.
 *
 * This file is the store — the settings, the saved searches, which orgs are
 * due and the claim, and the last night's report. The run itself is
 * `runNightShift` in `packages/tools/src/night.ts`, started by the worker,
 * which holds the Google key. Every setting is audited; every write the run
 * makes is the agency's own records and evidence; it sends nothing.
 */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { briefDue, isNeedKey, localDateIn, wallClockMinutes, type NeedKey } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isKnownTimeZone } from './contacts.js'
import { isUniqueViolation } from './pg-errors.js'

/** Saved searches an org may keep. */
export const NIGHT_SEARCHES_MAX = 10
/** Searches one night runs — each a Places search the agency pays for past Google's free tier. */
export const NIGHT_SEARCHES_PER_RUN = 5
/** Sites scanned in one night. */
export const NIGHT_SCANS_PER_RUN = 15
/** Sites measured by PageSpeed in one night. */
export const NIGHT_AUDITS_PER_RUN = 10
/** The morning list's length. */
export const NIGHT_TOP = 10

export interface NightShift {
  readonly enabled: boolean
  readonly runAt: string
  readonly timeZone: string
  readonly lastRunOn: string | null
  readonly requestedAt: Date | null
  readonly updatedBy: string | null
  readonly updatedAt: Date | null
}

export const NIGHT_DEFAULTS: NightShift = {
  enabled: false, runAt: '02:00', timeZone: 'Asia/Kolkata', lastRunOn: null, requestedAt: null, updatedBy: null, updatedAt: null,
}

export async function nightShiftRead(db: AgencyDb, orgId: string): Promise<NightShift> {
  const [row] = await db.select().from(schema.nightShifts).where(eq(schema.nightShifts.orgId, orgId)).limit(1)
  return row
    ? {
        enabled: row.enabled, runAt: row.runAt, timeZone: row.timeZone, lastRunOn: row.lastRunOn,
        requestedAt: row.requestedAt, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
      }
    : NIGHT_DEFAULTS
}

type Fail = { readonly ok: false; readonly message: string }

/** Switch it on or off, and set when, in which zone. Audited `night.updated`; switching off drops a waiting "run it now". */
export async function nightShiftSave(
  db: AgencyDb,
  args: { readonly orgId: string; readonly enabled: boolean; readonly runAt: string; readonly timeZone: string; readonly actor: string; readonly updatedBy: string | null },
): Promise<{ readonly ok: true } | Fail> {
  if (wallClockMinutes(args.runAt) === null || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(args.runAt)) {
    return { ok: false, message: 'The time is a 24-hour clock time, like 02:00.' }
  }
  if (!isKnownTimeZone(args.timeZone)) return { ok: false, message: `"${args.timeZone}" is not a time zone this server knows, e.g. Asia/Kolkata.` }
  const now = new Date()
  await db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    await t
      .insert(schema.nightShifts)
      .values({ orgId: args.orgId, enabled: args.enabled, runAt: args.runAt, timeZone: args.timeZone, updatedBy: args.updatedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.nightShifts.orgId,
        set: {
          enabled: args.enabled, runAt: args.runAt, timeZone: args.timeZone, updatedBy: args.updatedBy, updatedAt: now,
          ...(args.enabled ? {} : { requestedAt: null }),
        },
      })
    await appendAudit(t, {
      orgId: args.orgId, actor: args.actor, action: 'night.updated', subjectType: 'org', subjectId: args.orgId,
      detail: { enabled: args.enabled, at: args.runAt, timeZone: args.timeZone },
    })
  })
  return { ok: true }
}

/** "Run it now": due at the worker's next look, whatever the clock says. Only while it is on. */
export async function nightShiftRequest(db: AgencyDb, args: { readonly orgId: string; readonly actor: string }): Promise<{ readonly ok: true } | Fail> {
  const rows = await db
    .update(schema.nightShifts)
    .set({ requestedAt: new Date() })
    .where(and(eq(schema.nightShifts.orgId, args.orgId), eq(schema.nightShifts.enabled, true)))
    .returning({ id: schema.nightShifts.id })
  if (rows.length === 0) return { ok: false, message: 'Switch the night shift on first.' }
  await appendAudit(db, { orgId: args.orgId, actor: args.actor, action: 'night.requested', subjectType: 'org', subjectId: args.orgId, detail: {} })
  return { ok: true }
}

export type NightSearchRow = typeof schema.nightSearches.$inferSelect

export async function nightSearchesList(db: AgencyDb, orgId: string): Promise<NightSearchRow[]> {
  return db.select().from(schema.nightSearches).where(eq(schema.nightSearches.orgId, orgId)).orderBy(asc(schema.nightSearches.createdAt))
}

export async function nightSearchAdd(
  db: AgencyDb,
  args: { readonly orgId: string; readonly query: string; readonly region: string | null; readonly city: string | null; readonly createdBy: string | null; readonly actor: string },
): Promise<{ readonly ok: true; readonly search: NightSearchRow } | Fail> {
  const query = args.query.replace(/\s+/g, ' ').trim()
  if ([...query].length < 3 || [...query].length > 200) return { ok: false, message: 'A search is 3 to 200 characters, like "dentists in Indiranagar, Bengaluru".' }
  if (query.includes('\u0000')) return { ok: false, message: 'That search has a character that cannot be stored.' }
  const region = args.region?.trim().toUpperCase() || null
  if (region !== null && !/^[A-Z]{2}$/.test(region)) return { ok: false, message: 'The country is two letters, like IN.' }
  const city = args.city?.replace(/\s+/g, ' ').trim() || null
  if (city !== null && [...city].length > 80) return { ok: false, message: 'The city is at most 80 characters.' }
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.nightSearches).where(eq(schema.nightSearches.orgId, args.orgId))
  if (n >= NIGHT_SEARCHES_MAX) return { ok: false, message: `An organisation keeps at most ${NIGHT_SEARCHES_MAX} saved searches. Remove one first.` }
  try {
    const search = await db.transaction(async (tx) => {
      const t = tx as unknown as AgencyDb
      const [row] = await t.insert(schema.nightSearches).values({ orgId: args.orgId, query, region, city, createdBy: args.createdBy }).returning()
      await appendAudit(t, { orgId: args.orgId, actor: args.actor, action: 'night.search_added', subjectType: 'org', subjectId: args.orgId, detail: { searchId: row!.id } })
      return row!
    })
    return { ok: true, search }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, message: 'That search is already saved.' }
    throw err
  }
}

export async function nightSearchRemove(db: AgencyDb, args: { readonly orgId: string; readonly searchId: string; readonly actor: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    const rows = await t
      .delete(schema.nightSearches)
      .where(and(eq(schema.nightSearches.orgId, args.orgId), eq(schema.nightSearches.id, args.searchId)))
      .returning({ id: schema.nightSearches.id })
    if (rows.length === 0) return false
    await appendAudit(t, { orgId: args.orgId, actor: args.actor, action: 'night.search_removed', subjectType: 'org', subjectId: args.orgId, detail: { searchId: args.searchId } })
    return true
  })
}

export async function nightSearchSetActive(
  db: AgencyDb,
  args: { readonly orgId: string; readonly searchId: string; readonly active: boolean; readonly actor: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as AgencyDb
    const rows = await t
      .update(schema.nightSearches)
      .set({ active: args.active, updatedAt: new Date() })
      .where(and(eq(schema.nightSearches.orgId, args.orgId), eq(schema.nightSearches.id, args.searchId)))
      .returning({ id: schema.nightSearches.id })
    if (rows.length === 0) return false
    await appendAudit(t, {
      orgId: args.orgId, actor: args.actor, action: 'night.search_toggled', subjectType: 'org', subjectId: args.orgId,
      detail: { searchId: args.searchId, active: args.active },
    })
    return true
  })
}

/** Every org whose night shift is due now, by its own zone's clock, or asked for. */
export async function nightShiftsDue(db: AgencyDb, now: Date): Promise<{ readonly orgId: string; readonly localDate: string; readonly requested: boolean }[]> {
  const rows = await db.select().from(schema.nightShifts).where(eq(schema.nightShifts.enabled, true))
  const due: { orgId: string; localDate: string; requested: boolean }[] = []
  for (const r of rows) {
    const today = localDateIn(now, r.timeZone)
    if (!today) continue
    if (r.requestedAt !== null) {
      due.push({ orgId: r.orgId, localDate: today, requested: true })
      continue
    }
    const d = briefDue({ now, at: r.runAt, timeZone: r.timeZone, lastRunOn: r.lastRunOn })
    if (d.due) due.push({ orgId: r.orgId, localDate: d.localDate, requested: false })
  }
  return due
}

/** Claim tonight's run: ONE update that matches only while it is on and tonight has not run, or a run was asked for. */
export async function claimNightShift(db: AgencyDb, args: { readonly orgId: string; readonly localDate: string }): Promise<boolean> {
  const rows = await db
    .update(schema.nightShifts)
    .set({ lastRunOn: args.localDate, requestedAt: null })
    .where(and(
      eq(schema.nightShifts.orgId, args.orgId),
      eq(schema.nightShifts.enabled, true),
      or(
        sql`${schema.nightShifts.requestedAt} IS NOT NULL`,
        isNull(schema.nightShifts.lastRunOn),
        lt(schema.nightShifts.lastRunOn, sql`${args.localDate}::date`),
      ),
    ))
    .returning({ id: schema.nightShifts.id })
  return rows.length > 0
}

/** The search that ran longest ago first; never-run ones before all. */
export async function nightSearchesToRun(db: AgencyDb, orgId: string, limit = NIGHT_SEARCHES_PER_RUN): Promise<NightSearchRow[]> {
  return db
    .select()
    .from(schema.nightSearches)
    .where(and(eq(schema.nightSearches.orgId, orgId), eq(schema.nightSearches.active, true)))
    .orderBy(sql`${schema.nightSearches.lastRunAt} ASC NULLS FIRST`, asc(schema.nightSearches.createdAt))
    .limit(limit)
}

export interface NightReport {
  readonly at: Date
  readonly date: string | null
  readonly searches: number
  readonly added: number
  readonly scanned: number
  readonly audited: number
  /** The morning list: the best new finds, best first, as company rows. */
  readonly top: readonly (typeof schema.companies.$inferSelect)[]
  /** What each of them needs, by company id: keys from core's fixed list, never words. */
  readonly needs: ReadonlyMap<string, readonly NeedKey[]>
}

/** The latest night's report, from its `night.ran` row, with the companies of its list as they are now. */
export async function nightReportLatest(db: AgencyDb, orgId: string): Promise<NightReport | null> {
  const [row] = await db
    .select({ createdAt: schema.auditLog.createdAt, detail: schema.auditLog.detail })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'night.ran')))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(1)
  if (!row) return null
  const d = (row.detail ?? {}) as Record<string, unknown>
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0)
  const ids = Array.isArray(d.top) ? (d.top as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, NIGHT_TOP) : []
  const uuids = ids.filter((i) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i))
  const companies = uuids.length
    ? await db.select().from(schema.companies).where(and(eq(schema.companies.orgId, orgId), inArray(schema.companies.id, uuids)))
    : []
  const byId = new Map(companies.map((c) => [c.id, c]))
  const topNeeds = Array.isArray(d.topNeeds) ? (d.topNeeds as unknown[]) : []
  const needs = new Map<string, NeedKey[]>(
    ids.map((id, i) => {
      const keys = Array.isArray(topNeeds[i]) ? (topNeeds[i] as unknown[]) : []
      return [id, keys.filter((k): k is NeedKey => typeof k === 'string' && isNeedKey(k))]
    }),
  )
  return {
    at: row.createdAt,
    date: typeof d.date === 'string' ? d.date : null,
    searches: num('searches'),
    added: num('added'),
    scanned: num('scanned'),
    audited: num('audited'),
    top: ids.map((i) => byId.get(i)).filter((c): c is typeof schema.companies.$inferSelect => c !== undefined),
    needs,
  }
}
