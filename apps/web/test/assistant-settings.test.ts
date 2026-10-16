/**
 * Settings → Assistant (0020): who may read and change the playbook and the
 * morning brief, the three writes through their own calls — against a real
 * database and against one that fails — and the sentences the page shows.
 *
 * The routes themselves import `@/auth` and are pinned by reading their
 * source.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAssistantSettings, schema, type AgencyDb } from '@agency/db/queries'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  ASSISTANT_SAVE_FAULT, briefAnswer, briefRunAnswer, playbookAnswer, type AssistantLog,
} from '../src/app/api/settings/assistant/outcome'
import { briefSchema, mayReadAssistant, mayWriteAssistant, playbookSchema } from '../src/app/api/settings/assistant/rules'
import { PLAYBOOK_OUTLINE, briefStatus, briefWorkerLine } from '../src/app/settings/assistant/words'

const ORG = '11111111-1111-4111-8111-111111111111'

describe('who may read and change the assistant settings', () => {
  it('lets every member read them, and only an owner change them', () => {
    const owner = { id: 'u1', orgId: ORG, role: 'owner' as const }
    const member = { id: 'u2', orgId: ORG, role: 'member' as const }
    expect(mayReadAssistant(owner)).toBe(true)
    expect(mayWriteAssistant(owner)).toBe(true)
    expect(mayReadAssistant(member)).toBe(true)
    expect(mayWriteAssistant(member)).toBe(false)
    const stranger = { id: 'u3', orgId: ORG, role: 'viewer' as unknown as 'member' }
    expect(mayReadAssistant(stranger)).toBe(false)
    expect(mayWriteAssistant(null)).toBe(false)
  })

  it('reads only the shapes the routes accept', () => {
    expect(playbookSchema.safeParse({ playbook: 'x' }).success).toBe(true)
    expect(playbookSchema.safeParse({ playbook: 7 }).success).toBe(false)
    expect(briefSchema.safeParse({ enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' }).success).toBe(true)
    expect(briefSchema.safeParse({ enabled: 'yes', at: '08:30', timeZone: 'Asia/Kolkata' }).success).toBe(false)
  })
})

class DrizzleQueryError extends Error {
  override name = 'DrizzleQueryError'
}

describe('the assistant routes’ own calls', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let owner: string
  let lines: { message: string; fields: Record<string, unknown> }[]
  const log: AssistantLog = { error: (message, fields = {}) => lines.push({ message, fields }) }

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    lines = []
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    const [u] = await db.insert(schema.users).values({ orgId, email: 'owner@agency.test', role: 'owner' }).returning({ id: schema.users.id })
    owner = u!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  /** A database whose transactions throw the way drizzle does: the bound parameters in the message. */
  const broken = (): AgencyDb =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async () => {
            throw new DrizzleQueryError('Failed query: insert into "assistant_settings" … params: We charge DECOY-WORDS')
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

  it('saves the playbook, and refuses one over the bound with a sentence', async () => {
    expect(await playbookAnswer(db, { orgId, actor: owner, playbook: 'We secure SaaS apps.' }, log)).toEqual({
      status: 200, body: { ok: true, chars: 20 },
    })
    const long = await playbookAnswer(db, { orgId, actor: owner, playbook: 'x'.repeat(20_001) }, log)
    expect(long.status).toBe(400)
    expect(long.body.error).toMatch(/the most is 20,000/)
    expect((await readAssistantSettings(db, orgId)).playbook).toBe('We secure SaaS apps.')
  })

  it('answers a database fault with a sentence, and logs its class — never the words', async () => {
    const answer = await playbookAnswer(broken(), { orgId, actor: owner, playbook: 'We charge DECOY-WORDS' }, log)
    expect(answer).toEqual({ status: 500, body: { error: ASSISTANT_SAVE_FAULT } })
    expect(lines).toEqual([{ message: 'the playbook could not be saved', fields: { error: 'DrizzleQueryError' } }])
    expect(JSON.stringify(lines)).not.toContain('DECOY')
    expect((await briefAnswer(broken(), { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'UTC' }, log)).status).toBe(500)
    expect((await briefRunAnswer(broken(), { orgId, actor: owner }, log)).status).toBe(500)
  })

  it('saves the brief, refuses a time it cannot read, and runs one now only while it is on', async () => {
    const bad = await briefAnswer(db, { orgId, actor: owner, enabled: true, at: '8:30', timeZone: 'Asia/Kolkata' }, log)
    expect(bad).toMatchObject({ status: 400, body: { reason: 'bad_time' } })
    expect(await briefRunAnswer(db, { orgId, actor: owner }, log)).toMatchObject({ status: 409, body: { reason: 'off' } })
    expect(await briefAnswer(db, { orgId, actor: owner, enabled: true, at: '08:30', timeZone: 'Asia/Kolkata' }, log)).toEqual({
      status: 200, body: { ok: true },
    })
    expect(await briefRunAnswer(db, { orgId, actor: owner }, log)).toEqual({ status: 202, body: { ok: true } })
    expect((await readAssistantSettings(db, orgId)).briefRequestedAt).toBeInstanceOf(Date)
  })
})

describe('the sentences the page shows', () => {
  const on = { enabled: true, at: '08:30', timeZone: 'Asia/Kolkata', person: 'Priya', personCannotRun: false, lastRunOn: null, requested: false }

  it('says when it runs, as whom, and when it last ran', () => {
    expect(briefStatus({ ...on, enabled: false })).toEqual({ tone: 'off', text: 'Off. Nothing runs on its own.' })
    expect(briefStatus(on).text).toBe('On — every day at 08:30 (Asia/Kolkata), as Priya. It has not run yet.')
    expect(briefStatus({ ...on, lastRunOn: '2026-10-07', requested: true }).text).toBe(
      'On — every day at 08:30 (Asia/Kolkata), as Priya. Last ran for 2026-10-07. A brief was asked for, and starts at the worker’s next look, within a minute.',
    )
  })

  it('warns when the person it runs as has lost access, which runs nothing', () => {
    expect(briefStatus({ ...on, personCannotRun: true })).toMatchObject({ tone: 'warn', text: expect.stringMatching(/does not run/) })
    expect(briefStatus({ ...on, person: null }).tone).toBe('warn')
  })

  it('says from the heartbeat whether anything will write the brief', () => {
    expect(briefWorkerLine('live', 'on')).toEqual({ tone: 'ok', text: 'The worker is running and writes the brief.' })
    expect(briefWorkerLine('live', 'off').text).toMatch(/chat off/)
    expect(briefWorkerLine('live', null).text).toMatch(/started before the morning brief existed/)
    expect(briefWorkerLine('silent', 'on').text).toMatch(/not running now/)
    expect(briefWorkerLine('never', null).text).toMatch(/No worker has run/)
  })

  it('gives an outline with headings and no claims of its own', () => {
    expect(PLAYBOOK_OUTLINE).toMatch(/^WHAT WE DO/)
    for (const heading of ['WHO IT IS FOR', 'PRICES', 'PROOF', 'HOW WE WRITE']) expect(PLAYBOOK_OUTLINE).toContain(heading)
    expect(PLAYBOOK_OUTLINE).not.toMatch(/\d/)
  })
})

describe('the routes', () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  /** The source without comments, so a sentence ABOUT a call does not count as one. */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it.each([
    ['../src/app/api/settings/assistant/playbook/route.ts', 'playbookAnswer'],
    ['../src/app/api/settings/assistant/brief/route.ts', 'briefAnswer'],
    ['../src/app/api/settings/assistant/brief/run/route.ts', 'briefRunAnswer'],
  ])('%s asks for an owner before it calls %s, and calls nothing else that writes', (path, call) => {
    const src = code(read(path))
    expect(src.indexOf('mayWriteAssistant(')).toBeGreaterThan(-1)
    expect(src.indexOf('mayWriteAssistant(')).toBeLessThan(src.indexOf(`${call}(`))
    expect(src).not.toMatch(/savePlaybook|saveBrief|requestBrief/)
  })
})
