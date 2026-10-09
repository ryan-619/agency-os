/**
 * What changed (2026-10-09): `recordScan` compares a successful scan with the
 * one before and notes a gap fixed or opened — once per scan, scored signals
 * only, with a task where a deal is open — and `whatChanged` reads it back.
 * Nothing is noted for a first scan, an unchanged one, a failed one, or an
 * informational signal; and a note that cannot be written never costs the scan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'
import { parseIcpDefinition, type IcpDefinition, type Observation, type SiteProfile } from '@agency/core'
import { migratedDb, type TestDb } from './helpers.js'
import * as schema from '../src/schema.js'
import { SEED_DIR } from '../src/paths.js'
import { recordScan, type AgencyDb } from '../src/repository.js'
import { whatChanged } from '../src/evidence-signals.js'

const icp: IcpDefinition = parseIcpDefinition(JSON.parse(readFileSync(join(SEED_DIR, 'icp-security-gap-saas.json'), 'utf8')))

function reached(over: { gaps?: string[]; unobserved?: string[]; informational?: Record<string, boolean> } = {}): SiteProfile {
  const { gaps = [], unobserved = [], informational = {} } = over
  const observations: Record<string, Observation> = {}
  for (const key of Object.keys(icp.signals)) {
    observations[key] = { observed: true, gap: false, detail: 'present', evidence: { header: key, seen: 'present' } }
  }
  for (const key of gaps) observations[key] = { observed: true, gap: true, detail: 'absent', evidence: { header: key, seen: 'absent' } }
  for (const key of unobserved) observations[key] = { observed: false, gap: null, detail: 'timeout', evidence: { outcome: 'no response' } }
  for (const [key, gap] of Object.entries(informational)) observations[key] = { observed: true, gap, detail: gap ? 'weak' : 'fine', evidence: { k: key } }
  return {
    domain: 'acme.test', company: 'Acme', title: 'Acme', fetchOk: true, fetchError: '', hasLoginSurface: true,
    isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations,
  }
}
const unreachable: SiteProfile = {
  domain: 'acme.test', company: '', title: '', fetchOk: false, fetchError: 'TimeoutError',
  hasLoginSurface: false, isSecurityVendor: false, mentionsSecurityHiring: false, outdatedLibs: [], observations: {},
}

describe('what changed', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let ownerId: string
  let companyId: string
  let icpProfile: { id: string; definition: IcpDefinition }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    orgId = (await db.insert(schema.orgs).values({ name: 'Accemy' }).returning({ id: schema.orgs.id }))[0]!.id
    ownerId = (await db.insert(schema.users).values({ orgId, email: 'ryan@accemy.test', role: 'owner' }).returning({ id: schema.users.id }))[0]!.id
    const [p] = await db.insert(schema.icpProfiles).values({ orgId, name: icp.label, definition: icp as unknown as Record<string, unknown> }).returning({ id: schema.icpProfiles.id })
    icpProfile = { id: p!.id, definition: icp }
    companyId = (await db.insert(schema.companies).values({ orgId, domain: 'acme.test', name: 'Acme', phone: '+918041234567' }).returning({ id: schema.companies.id }))[0]!.id
  })
  afterEach(async () => {
    await test.close()
  })

  const scan = (profile: SiteProfile) => recordScan(db, { orgId, companyId, icpProfile, raw: {}, profile })
  const notes = () => db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, 'evidence.changed')))
  const tasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.companyId, companyId))

  it('notes nothing for a first scan, an unchanged one or a failed one, and nothing for an informational change', async () => {
    expect((await scan(reached({ gaps: ['csp'] }))).changed).toBeNull()
    expect((await scan(reached({ gaps: ['csp'] }))).changed).toBeNull()
    expect((await scan(unreachable)).changed).toBeNull()
    expect((await scan(reached({ gaps: ['csp'], informational: { cookie_flags: true } }))).changed).toBeNull()
    expect(await notes()).toEqual([])
    expect(await whatChanged(db, { orgId, now: new Date() })).toEqual([])
  })

  it('notes a gap fixed and a gap opened once, with the keys and no detail, and a task for the open deal’s owner', async () => {
    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted', ownerUserId: ownerId })
    await scan(reached({ gaps: ['csp', 'hsts'] }))
    const out = await scan(reached({ gaps: ['hsts', 'trust_page'], unobserved: ['tls'] }))
    expect(out.changed).toMatchObject({ fixed: ['csp'], regressed: ['trust_page'] })
    expect(out.changed!.taskId).toBeTruthy()

    const [note] = await notes()
    expect(note!.subjectId).toBe(companyId)
    expect(note!.detail).toMatchObject({ scanId: out.scanId, fixed: 1, regressed: 1, keys: { fixed: ['csp'], regressed: ['trust_page'] }, taskId: out.changed!.taskId })
    expect(JSON.stringify(note!.detail)).not.toContain('absent')

    const [task] = await tasks()
    expect(task).toMatchObject({ kind: 'call', assigneeUserId: ownerId, title: 'Call Acme: their site lost something since our last look' })
    expect(task!.detail).toContain('New gaps:')
    expect(task!.detail).toContain('Fixed:')
    expect(task!.detail).toContain(icp.signals.trust_page!.why)

    const read = await whatChanged(db, { orgId, now: new Date() })
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ company: { id: companyId, domain: 'acme.test' }, fixed: ['csp'], regressed: ['trust_page'], openDeal: true, taskId: out.changed!.taskId })
    expect(await whatChanged(db, { orgId, now: new Date(Date.now() + 10 * 86_400_000) })).toEqual([])
  })

  it('words a fix alone as a follow-up, makes a to-do where there is no number, and no task without an open deal', async () => {
    await db.update(schema.companies).set({ phone: null }).where(eq(schema.companies.id, companyId))
    await scan(reached({ gaps: ['csp'] }))
    const noDeal = await scan(reached({}))
    expect(noDeal.changed).toMatchObject({ fixed: ['csp'], regressed: [], taskId: null })
    expect(await tasks()).toEqual([])

    await db.insert(schema.deals).values({ orgId, companyId, stage: 'contacted' })
    // The gap comes back (a regression, a to-do: there is no number) and is fixed again (a follow-up).
    const back = await scan(reached({ gaps: ['csp'] }))
    expect(back.changed).toMatchObject({ fixed: [], regressed: ['csp'] })
    const out = await scan(reached({}))
    expect(out.changed?.taskId).toBeTruthy()
    const made = (await tasks()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    expect(made).toHaveLength(2)
    expect(made[0]).toMatchObject({ kind: 'todo', assigneeUserId: null, title: 'Call Acme: their site lost something since our last look' })
    expect(made[1]).toMatchObject({ kind: 'todo', assigneeUserId: null, title: 'Follow up Acme: they fixed something on their site' })
    expect(await notes()).toHaveLength(3)
  })

  it('reads another org’s notes for nobody', async () => {
    await scan(reached({ gaps: ['csp'] }))
    await scan(reached({}))
    const other = (await db.insert(schema.orgs).values({ name: 'Other' }).returning({ id: schema.orgs.id }))[0]!.id
    expect(await whatChanged(db, { orgId: other, now: new Date() })).toEqual([])
    expect(await whatChanged(db, { orgId, now: new Date() })).toHaveLength(1)
  })
})
