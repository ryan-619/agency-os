/**
 * Settings → Assistant (0020): the agency's playbook, which the AI reads on
 * every turn, and the morning brief, which the worker starts once a day.
 *
 * One row per org (`assistant_settings_one_per_org`), written by upsert, so a
 * page that never saved anything reads the defaults and the first save makes
 * the row. Each save writes its audit row in the same transaction: counts and
 * settings, never the playbook's words.
 */
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { briefDue, localDateIn, localWallClock, WALL_CLOCK } from '@agency/core'
import * as schema from './schema.js'
import type { AgencyDb } from './repository.js'
import { appendAudit } from './approvals.js'
import { isKnownTimeZone } from './contacts.js'

/** The playbook's bound, the CHECK's: every character is sent with every message. */
export const PLAYBOOK_MAX_CHARS = 20_000

/** The audit rows' subject: the org's assistant settings, one per org, so no id is needed. */
export const ASSISTANT_SUBJECT = 'assistant'

export interface AssistantSettings {
  readonly playbook: string
  /** Who last saved the playbook, and when; null before the first save (or once that person is deleted). */
  readonly playbookUpdatedBy: string | null
  readonly playbookUpdatedAt: Date | null
  readonly briefEnabled: boolean
  readonly briefUserId: string | null
  readonly briefAt: string
  readonly briefTimeZone: string
  /** The zone's own date of the last brief, YYYY-MM-DD. */
  readonly briefLastRunOn: string | null
  /** A brief somebody asked for with "Run it now", not yet started. */
  readonly briefRequestedAt: Date | null
}

/** What an org that never saved anything reads: the column defaults. */
export const ASSISTANT_DEFAULTS: AssistantSettings = Object.freeze({
  playbook: '',
  playbookUpdatedBy: null,
  playbookUpdatedAt: null,
  briefEnabled: false,
  briefUserId: null,
  briefAt: '08:30',
  briefTimeZone: 'Asia/Kolkata',
  briefLastRunOn: null,
  briefRequestedAt: null,
})

export async function readAssistantSettings(db: AgencyDb, orgId: string): Promise<AssistantSettings> {
  const rows = await db
    .select()
    .from(schema.assistantSettings)
    .where(eq(schema.assistantSettings.orgId, orgId))
    .limit(1)
  const row = rows[0]
  if (!row) return ASSISTANT_DEFAULTS
  return {
    playbook: row.playbook,
    playbookUpdatedBy: row.playbookUpdatedBy,
    playbookUpdatedAt: row.playbookUpdatedAt,
    briefEnabled: row.briefEnabled,
    briefUserId: row.briefUserId,
    briefAt: row.briefAt,
    briefTimeZone: row.briefTimeZone,
    briefLastRunOn: row.briefLastRunOn,
    briefRequestedAt: row.briefRequestedAt,
  }
}

/** The playbook alone, as the worker reads it at the start of every turn. */
export async function readPlaybook(db: AgencyDb, orgId: string): Promise<string> {
  return (await readAssistantSettings(db, orgId)).playbook
}

export type SavePlaybookResult =
  | { readonly ok: true; readonly chars: number }
  | { readonly ok: false; readonly reason: 'too_long' | 'nul'; readonly message: string }

/**
 * Save the playbook: line endings made plain, ends trimmed, at most
 * PLAYBOOK_MAX_CHARS characters (code points, as Postgres counts). An empty
 * playbook is allowed — it is how the AI stops being told anything.
 */
export async function savePlaybook(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string; readonly playbook: string },
): Promise<SavePlaybookResult> {
  const text = args.playbook.replace(/\r\n?/g, '\n').trim()
  if (text.includes('\u0000')) {
    return { ok: false, reason: 'nul', message: 'The playbook contains a character the database cannot store (U+0000). Remove it and save again.' }
  }
  const chars = [...text].length
  if (chars > PLAYBOOK_MAX_CHARS) {
    return {
      ok: false,
      reason: 'too_long',
      message: `The playbook is ${chars.toLocaleString('en')} characters; the most is ${PLAYBOOK_MAX_CHARS.toLocaleString('en')}, because all of it is sent with every message. Shorten it and save again.`,
    }
  }
  await db.transaction(async (tx) => {
    const before = await readAssistantSettings(tx as unknown as AgencyDb, args.orgId)
    const set = { playbook: text, playbookUpdatedBy: args.actor, playbookUpdatedAt: sql`now()` }
    await tx
      .insert(schema.assistantSettings)
      .values({ orgId: args.orgId, ...set })
      .onConflictDoUpdate({ target: schema.assistantSettings.orgId, set })
    await appendAudit(tx as unknown as AgencyDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'assistant.playbook_updated',
      subjectType: ASSISTANT_SUBJECT,
      // Counts only: the playbook is the agency's words, and the log holds ids and counts.
      detail: { chars, before: [...before.playbook].length },
    })
  })
  return { ok: true, chars }
}

export type SaveBriefResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad_time' | 'bad_zone'; readonly message: string }

/**
 * Switch the morning brief on or off, and set when it runs. Switched on, it
 * runs in the name of whoever saved it, in a thread of theirs.
 */
export async function saveBrief(
  db: AgencyDb,
  args: {
    readonly orgId: string
    readonly actor: string
    readonly enabled: boolean
    readonly at: string
    readonly timeZone: string
  },
): Promise<SaveBriefResult> {
  if (!WALL_CLOCK.test(args.at)) {
    return { ok: false, reason: 'bad_time', message: 'The time must be HH:MM on a 24-hour clock, such as 08:30.' }
  }
  if (!isKnownTimeZone(args.timeZone) || !/^[A-Za-z0-9_+/-]{1,64}$/.test(args.timeZone)) {
    return { ok: false, reason: 'bad_zone', message: `"${args.timeZone.slice(0, 64)}" is not a time zone this server knows, such as Asia/Kolkata or Europe/London.` }
  }
  await db.transaction(async (tx) => {
    const set = {
      briefEnabled: args.enabled,
      briefAt: args.at,
      briefTimeZone: args.timeZone,
      // Switched on, it runs as whoever switched it on; switched off, the
      // person it last ran as is kept, which runs nothing — and a "Run it
      // now" still waiting is dropped, or switching it back on weeks later
      // would start a brief nobody asked for that day.
      ...(args.enabled ? { briefUserId: args.actor } : { briefRequestedAt: null }),
    }
    await tx
      .insert(schema.assistantSettings)
      .values({ orgId: args.orgId, ...set })
      .onConflictDoUpdate({ target: schema.assistantSettings.orgId, set })
    await appendAudit(tx as unknown as AgencyDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'assistant.brief_updated',
      subjectType: ASSISTANT_SUBJECT,
      detail: { enabled: args.enabled, at: args.at, timeZone: args.timeZone },
    })
  })
  return { ok: true }
}

export interface DueBrief {
  readonly orgId: string
  readonly userId: string
  /** The zone's date now, which the claim spends. */
  readonly localDate: string
  /** The zone's wall-clock time now, HH:MM: when the brief starts, which the prompt names. */
  readonly localTime: string
  /** The time it is set for, HH:MM. */
  readonly at: string
  readonly timeZone: string
  /** Somebody pressed "Run it now", so it is due whatever the clock says. */
  readonly requested: boolean
}

/**
 * Every brief due now, across every org: switched on, with somebody to run
 * as who still has access, and either asked for ("Run it now") or the zone's
 * clock past its time on a day that has not had one. A row that cannot run —
 * no person, a revoked one — is left alone; the settings page says why.
 */
export async function briefsDue(db: AgencyDb, now: Date): Promise<DueBrief[]> {
  const rows = await db
    .select({
      orgId: schema.assistantSettings.orgId,
      userId: schema.assistantSettings.briefUserId,
      at: schema.assistantSettings.briefAt,
      timeZone: schema.assistantSettings.briefTimeZone,
      lastRunOn: schema.assistantSettings.briefLastRunOn,
      requestedAt: schema.assistantSettings.briefRequestedAt,
    })
    .from(schema.assistantSettings)
    .innerJoin(
      schema.users,
      and(
        eq(schema.users.id, schema.assistantSettings.briefUserId),
        eq(schema.users.orgId, schema.assistantSettings.orgId),
      ),
    )
    .where(
      and(
        eq(schema.assistantSettings.briefEnabled, true),
        isNotNull(schema.assistantSettings.briefUserId),
        isNull(schema.users.revokedAt),
      ),
    )
  const due: DueBrief[] = []
  for (const r of rows) {
    const localTime = localWallClock(now, r.timeZone)
    if (!r.userId || localTime === null) continue
    const requested = r.requestedAt !== null
    const localDate = requested
      ? localDateIn(now, r.timeZone)
      : (() => {
          const verdict = briefDue({ now, at: r.at, timeZone: r.timeZone, lastRunOn: r.lastRunOn })
          return verdict.due ? verdict.localDate : null
        })()
    if (localDate === null) continue
    due.push({ orgId: r.orgId, userId: r.userId, localDate, localTime, at: r.at, timeZone: r.timeZone, requested })
  }
  return due
}

/**
 * Claim a day's brief: one UPDATE that matches only while the brief is on and
 * either that day has not run or somebody asked for one, so two workers — or
 * one that restarts mid-minute — start one brief a day, and one per press of
 * "Run it now". The claim spends both: the day is marked run and the request
 * cleared, so a brief asked for at 07:00 is that day's, and the 08:30 one does
 * not follow it. Null when somebody else claimed it, or it was switched off
 * meanwhile.
 */
export async function claimBrief(
  db: AgencyDb,
  args: { readonly orgId: string; readonly localDate: string },
): Promise<{ readonly userId: string } | null> {
  const rows = await db
    .update(schema.assistantSettings)
    .set({ briefLastRunOn: args.localDate, briefRequestedAt: null })
    .where(
      and(
        eq(schema.assistantSettings.orgId, args.orgId),
        eq(schema.assistantSettings.briefEnabled, true),
        isNotNull(schema.assistantSettings.briefUserId),
        or(
          isNotNull(schema.assistantSettings.briefRequestedAt),
          isNull(schema.assistantSettings.briefLastRunOn),
          lt(schema.assistantSettings.briefLastRunOn, sql`${args.localDate}::date`),
        ),
      ),
    )
    .returning({ userId: schema.assistantSettings.briefUserId })
  const userId = rows[0]?.userId
  return userId ? { userId } : null
}

export type RequestBriefResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'off' | 'nobody'; readonly message: string }

/**
 * "Run it now": ask the worker for a brief at its next look, whatever the
 * clock says. Only while the brief is on, and only while the person it runs
 * as still has access — a request nobody could run would wait for ever. It
 * runs as that person, in a thread of theirs, exactly as the daily one does,
 * and the claim that starts it marks the day run.
 */
export async function requestBrief(
  db: AgencyDb,
  args: { readonly orgId: string; readonly actor: string },
): Promise<RequestBriefResult> {
  return db.transaction(async (tx) => {
    // Locked, so a save switching it off in between cannot be undone by this request.
    const [row] = await tx
      .select({ enabled: schema.assistantSettings.briefEnabled, userId: schema.assistantSettings.briefUserId })
      .from(schema.assistantSettings)
      .where(eq(schema.assistantSettings.orgId, args.orgId))
      .limit(1)
      .for('update')
    if (!row?.enabled) {
      return { ok: false, reason: 'off', message: 'The morning brief is off. Switch it on and save, then run it.' }
    }
    const [person] = row.userId
      ? await tx
          .select({ revokedAt: schema.users.revokedAt })
          .from(schema.users)
          .where(and(eq(schema.users.id, row.userId), eq(schema.users.orgId, args.orgId)))
          .limit(1)
      : []
    if (!person || person.revokedAt) {
      return {
        ok: false,
        reason: 'nobody',
        message: 'The person the brief runs as no longer has access. Save the brief again to run it as you, then run it.',
      }
    }
    await tx
      .update(schema.assistantSettings)
      .set({ briefRequestedAt: sql`now()` })
      .where(eq(schema.assistantSettings.orgId, args.orgId))
    await appendAudit(tx as unknown as AgencyDb, {
      orgId: args.orgId,
      actor: args.actor,
      action: 'assistant.brief_requested',
      subjectType: ASSISTANT_SUBJECT,
    })
    return { ok: true }
  })
}

export interface LatestBrief {
  readonly chatSessionId: string
  /** Whose thread it is: only they can open it (`chatReadOwnSession`). */
  readonly userId: string
  readonly startedAt: Date
  /** The zone's date the brief was for, as the scheduler wrote it. */
  readonly date: string | null
}

/**
 * The newest brief the worker STARTED in this org, found through its
 * `assistant.brief_started` row rather than by the thread's title, which its
 * owner may rename. Null when none has started, or its thread is gone.
 */
export async function latestBrief(db: AgencyDb, orgId: string): Promise<LatestBrief | null> {
  const rows = await db
    .select({
      chatSessionId: schema.chatSessions.id,
      userId: schema.chatSessions.userId,
      startedAt: schema.auditLog.createdAt,
      detail: schema.auditLog.detail,
    })
    .from(schema.auditLog)
    .innerJoin(
      schema.chatSessions,
      and(eq(schema.chatSessions.id, schema.auditLog.subjectId), eq(schema.chatSessions.orgId, schema.auditLog.orgId)),
    )
    .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'assistant.brief_started')))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const date =
    typeof row.detail === 'object' && row.detail !== null && typeof (row.detail as { date?: unknown }).date === 'string'
      ? (row.detail as { date: string }).date
      : null
  return { chatSessionId: row.chatSessionId, userId: row.userId, startedAt: row.startedAt, date }
}
