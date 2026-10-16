/**
 * Settings → Assistant (0020): the playbook and the morning brief's schedule,
 * against a real migrated database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import {
  ASSISTANT_DEFAULTS, PLAYBOOK_MAX_CHARS, appendAudit, briefsDue, claimBrief, createChatSession, latestBrief,
  readAssistantSettings, readPlaybook, requestBrief, saveBrief, savePlaybook, schema, type AgencyDb,
} from '../src/index.js'
import { migratedDb, type TestDb } from './helpers.js'

describe('assistant settings', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let owner: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Northwind Security' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [u] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    owner = u!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  const audit = (action: string) =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))

  it('reads the defaults before anything is saved', async () => {
    expect(await readAssistantSettings(db, orgId)).toEqual(ASSISTANT_DEFAULTS)
    expect(await readPlaybook(db, orgId)).toBe('')
  })

  it('saves the playbook trimmed, with plain line endings, and audits counts only', async () => {
    expect(await savePlaybook(db, { orgId, actor: owner, playbook: '  We secure SaaS apps.\r\nDay rate: $1,200.  ' })).toEqual({ ok: true, chars: 38 })
    expect(await readPlaybook(db, orgId)).toBe('We secure SaaS apps.\nDay rate: $1,200.')
    const saved = await readAssistantSettings(db, orgId)
    expect(saved.playbookUpdatedBy).toBe(owner)
    expect(saved.playbookUpdatedAt).toBeInstanceOf(Date)
    await savePlaybook(db, { orgId, actor: owner, playbook: 'Shorter.' })
    expect(await readPlaybook(db, orgId)).toBe('Shorter.')
    const rows = await audit('assistant.playbook_updated')
    expect(rows.map((r) => r.detail)).toEqual([{ chars: 38, before: 0 }, { chars: 8, before: 38 }])
    expect(JSON.stringify(rows)).not.toContain('Day rate')
  })

  it('refuses a playbook over the bound, and a NUL, writing nothing', async () => {
    const long = await savePlaybook(db, { orgId, actor: owner, playbook: 'x'.repeat(PLAYBOOK_MAX_CHARS + 1) })
    expect(long).toMatchObject({ ok: false, reason: 'too_long' })
    const nul = await savePlaybook(db, { orgId, actor: owner, playbook: 'a\u0000b' })
    expect(nul).toMatchObject({ ok: false, reason: 'nul' })
    expect(await readPlaybook(db, orgId)).toBe('')
    expect(await audit('assistant.playbook_updated')).toEqual([])
  })

  it('counts the bound in characters, as Postgres does, so emoji are one each', async () => {
    const emoji = '🔒'.repeat(PLAYBOOK_MAX_CHARS)
    expect(await savePlaybook(db, { orgId, actor: owner, playbook: emoji })).toEqual({ ok: true, chars: PLAYBOOK_MAX_CHARS })
  })

  it('saves the brief, refusing a time or zone it cannot read, and runs it as whoever switched it on', async () => {
    expect(await saveBrief(db, { orgId, actor: owner, enabled: true, at: '8:30', timeZone: 'Asia/Kolkata' })).toMatchObject({ ok: false, reason: 'bad_time' })
    expect(await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Mars/Olympus' })).toMatchObject({ ok: false, reason: 'bad_zone' })
    expect(await saveBrief(db, { orgId, actor: owner, enabled: true, at: '07:45', timeZone: 'Europe/London' })).toEqual({ ok: true })
    expect(await readAssistantSettings(db, orgId)).toMatchObject({
      briefEnabled: true, briefUserId: owner, briefAt: '07:45', briefTimeZone: 'Europe/London',
    })
    const rows = await audit('assistant.brief_updated')
    expect(rows.map((r) => r.detail)).toEqual([{ enabled: true, at: '07:45', timeZone: 'Europe/London' }])
  })

  it('finds a brief due by the zone’s clock, claims the day once, and not again', async () => {
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    expect(await briefsDue(db, new Date('2026-10-07T02:00:00Z'))).toEqual([]) // 07:30 in Kolkata
    const now = new Date('2026-10-07T03:10:00Z') // 08:40 in Kolkata
    expect(await briefsDue(db, now)).toEqual([
      { orgId, userId: owner, localDate: '2026-10-07', localTime: '08:40', at: '08:30', timeZone: 'Asia/Kolkata', requested: false },
    ])
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toEqual({ userId: owner })
    // A second worker, or the same one a minute later, claims nothing.
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toBeNull()
    expect(await briefsDue(db, now)).toEqual([])
    // Tomorrow it is due again.
    expect(await briefsDue(db, new Date('2026-10-08T03:10:00Z'))).toHaveLength(1)
  })

  it('runs nobody’s brief when it is off, or when the person it runs as lost access', async () => {
    const now = new Date('2026-10-07T03:10:00Z')
    await saveBrief(db, { orgId, actor: owner, enabled: false, at: '08:30', timeZone: 'Asia/Kolkata' })
    expect(await briefsDue(db, now)).toEqual([])
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toBeNull()

    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    await db.update(schema.users).set({ revokedAt: now }).where(eq(schema.users.id, owner))
    expect(await briefsDue(db, now)).toEqual([])
  })

  it('runs one brief now when asked, whatever the clock says, and spends the day with it', async () => {
    expect(await requestBrief(db, { orgId, actor: owner })).toMatchObject({ ok: false, reason: 'off' })
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    const early = new Date('2026-10-07T01:30:00Z') // 07:00 in Kolkata, before its time
    expect(await briefsDue(db, early)).toEqual([])
    expect(await requestBrief(db, { orgId, actor: owner })).toEqual({ ok: true })
    expect(await briefsDue(db, early)).toEqual([
      { orgId, userId: owner, localDate: '2026-10-07', localTime: '07:00', at: '08:30', timeZone: 'Asia/Kolkata', requested: true },
    ])
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toEqual({ userId: owner })
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toBeNull()
    // The request was that day's brief: 08:30 does not start a second one.
    expect(await briefsDue(db, new Date('2026-10-07T03:10:00Z'))).toEqual([])
    // Asked for again the same day, it runs again — once.
    await requestBrief(db, { orgId, actor: owner })
    expect(await briefsDue(db, new Date('2026-10-07T09:00:00Z'))).toHaveLength(1)
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toEqual({ userId: owner })
    expect(await claimBrief(db, { orgId, localDate: '2026-10-07' })).toBeNull()
    expect(await audit('assistant.brief_requested')).toHaveLength(2)
  })

  it('drops a waiting request when the brief is switched off, and refuses one nobody could run', async () => {
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    await requestBrief(db, { orgId, actor: owner })
    await saveBrief(db, { orgId, actor: owner, enabled: false, at: '08:30', timeZone: 'Asia/Kolkata' })
    expect((await readAssistantSettings(db, orgId)).briefRequestedAt).toBeNull()
    await saveBrief(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' })
    expect(await briefsDue(db, new Date('2026-10-07T01:30:00Z'))).toEqual([])

    await db.update(schema.users).set({ revokedAt: new Date() }).where(eq(schema.users.id, owner))
    expect(await requestBrief(db, { orgId, actor: owner })).toMatchObject({ ok: false, reason: 'nobody' })
  })

  it('finds the newest brief by its started row, whatever its thread is called now', async () => {
    expect(await latestBrief(db, orgId)).toBeNull()
    for (const date of ['2026-10-06', '2026-10-07']) {
      const thread = await createChatSession(db, { orgId, userId: owner, title: `Morning brief · ${date}` })
      await appendAudit(db, {
        orgId, actor: 'system', action: 'assistant.brief_started', subjectType: 'chat_session', subjectId: thread.id,
        detail: { date, requested: false },
      })
      await new Promise((r) => setTimeout(r, 5)) // PGlite's clock is millisecond-grained
    }
    const latest = await latestBrief(db, orgId)
    expect(latest).toMatchObject({ userId: owner, date: '2026-10-07' })
    await db.update(schema.chatSessions).set({ title: 'renamed' }).where(eq(schema.chatSessions.id, latest!.chatSessionId))
    expect((await latestBrief(db, orgId))?.chatSessionId).toBe(latest!.chatSessionId)
  })

  it('refuses a playbook editor or a brief owner from another org (the same-org keys)', async () => {
    const [other] = await db.insert(schema.orgs).values({ name: 'Elsewhere' }).returning({ id: schema.orgs.id })
    const [stranger] = await db.insert(schema.users).values({ orgId: other!.id, email: 'x@elsewhere.test', role: 'owner' }).returning({ id: schema.users.id })
    await expect(savePlaybook(db, { orgId, actor: stranger!.id, playbook: 'hi' })).rejects.toThrow()
    await expect(saveBrief(db, { orgId, actor: stranger!.id, enabled: true, at: '08:30', timeZone: 'UTC' })).rejects.toThrow()
  })
})
