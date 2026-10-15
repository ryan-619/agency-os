/**
 * What a conversation has shown the agent (chat/ledger.ts, 2026-10-13).
 *
 * The tools that write an address, a person or a website ask this ledger
 * whether the value was shown — typed by the person, or returned by a tool
 * that reads from outside the agency. So the properties that matter are about
 * what can NEVER count: the model's own input echoed back by the call it made,
 * a helper's answer, the agency's own records read back, the morning brief's
 * prompt, and anything past the bounds. Each is asserted here with
 * `@agency/core`'s own readers (`textShowsEmail` and the rest), the tests the
 * tools will hand to `find`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/pglite'
import {
  morningBriefPrompt, textNamesPerson, textShowsDomain, textShowsEmail, textShowsPhone,
} from '@agency/core'
import { appendChatMessage, schema, type AgencyDb } from '@agency/db'
import { migratedDb, type TestDb } from '../../../packages/db/test/helpers.js'
import {
  ConversationLedgers, LEDGER_IDLE_MS, LEDGER_RESULT_MAX_CHARS, LEDGER_SESSIONS_MAX, LEDGER_TOOL_TEXT_MAX,
  READS_FROM_OUTSIDE, resultCountsAsShown, stripEchoes, toolResponseText,
} from '../src/chat/ledger.js'

/** A db no test below reads from: every in-memory test answers before any read could matter. */
function emptyDb(): AgencyDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
  }
  return { select: () => chain } as unknown as AgencyDb
}

const mcp = (text: string) => ({ content: [{ type: 'text', text }] })
/** One turn's id for the stored messages below. */
const TURN = randomUUID()
const EXA = 'mcp__exa__web_search_exa'

function ledger(over: { now?: () => Date } = {}) {
  const ledgers = new ConversationLedgers(over)
  return { ledgers, session: ledgers.forSession({ db: emptyDb(), orgId: 'org-1', sessionId: 'session-1' }) }
}

describe('what counts as shown', () => {
  it('finds a value the person typed, as the person', async () => {
    const { session } = ledger()
    session.addPerson('Add Ravi Kumar, ravi@acmedental.in, +91 98765 43210')
    expect(await session.find((t) => textShowsEmail(t, 'ravi@acmedental.in'))).toEqual([{ kind: 'person' }])
    expect(await session.find((t) => textShowsPhone(t, '+919876543210'))).toEqual([{ kind: 'person' }])
    expect(await session.find((t) => textNamesPerson(t, 'Ravi', 'Kumar'))).toEqual([{ kind: 'person' }])
  })

  it('finds a value a connector returned, under the tool’s full name', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp('Acme Dental — Contact us at info@acmedental.in'), { query: 'dentists in pune' })
    expect(await session.find((t) => textShowsEmail(t, 'info@acmedental.in'))).toEqual([{ kind: 'tool', tool: EXA }])
  })

  it('names the person first, then each tool once', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp('acmedental.in'), { query: 'one' })
    session.addToolResult(EXA, mcp('see acmedental.in'), { query: 'two' })
    // A directory page naming the site — not the site naming itself, which never counts (below).
    session.addToolResult('mcp__agency__read_page', mcp('Acme Dental, Pune — www.acmedental.in'), {
      url: 'https://www.justdial.com/Pune/Acme-Dental',
    })
    session.addPerson('their site is acmedental.in')
    expect(await session.find((t) => textShowsDomain(t, 'acmedental.in'))).toEqual([
      { kind: 'person' },
      { kind: 'tool', tool: EXA },
      { kind: 'tool', tool: 'mcp__agency__read_page' },
    ])
  })

  it('answers nothing for a value nobody showed', async () => {
    const { session } = ledger()
    session.addPerson('find me dentists in pune')
    session.addToolResult(EXA, mcp('Acme Dental, Pune — acmedental.in'), { query: 'dentists in pune' })
    expect(await session.find((t) => textShowsEmail(t, 'akash@acmedental.in'))).toEqual([])
  })

  it('reads a test that throws as "not here", never as a failure of the question', async () => {
    const { session } = ledger()
    session.addPerson('hello')
    expect(
      await session.find(() => {
        throw new Error('boom')
      }),
    ).toEqual([])
  })

  /**
   * A helper's answer is a model's own words, and the agency's other tools
   * read back what the agency recorded — the assistant's notes and research
   * claims among them. A guess written into a note and read back must not
   * come back as seen.
   */
  it('never counts a helper’s answer, a built-in, or the agency reading its own records', async () => {
    const { session } = ledger()
    const guess = 'Founder email is probably akash@farmley.com'
    session.addToolResult('Agent', [{ type: 'text', text: guess }], { prompt: 'find the founder' })
    session.addToolResult('Task', guess, {})
    session.addToolResult('mcp__agency__get_research', mcp(guess), { companyId: 'c-1' })
    session.addToolResult('mcp__agency__get_company_timeline', mcp(guess), { companyId: 'c-1' })
    session.addToolResult('mcp__agency__list_tasks', mcp(guess), {})
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
  })

  it('counts a connector and the agency’s readers of the outside world, and nothing else', () => {
    expect(resultCountsAsShown('mcp__exa__web_search_exa')).toBe(true)
    expect(resultCountsAsShown('mcp__jina__read_url')).toBe(true)
    for (const tool of READS_FROM_OUTSIDE) expect(resultCountsAsShown(`mcp__agency__${tool}`)).toBe(true)
    for (const name of [
      'mcp__agency__get_research', 'mcp__agency__search_crm', 'mcp__agency__check_contacts', 'mcp__agency__get_replies',
      'Agent', 'WebFetch', 'mcp__agency__', 'mcp____x',
    ]) {
      expect(resultCountsAsShown(name)).toBe(false)
    }
  })
  /**
   * A search answers in long dumps, and the people the assistant invented had
   * common names: "Alex" on one result and "Chen" on another named nobody.
   */
  it('names a person only where the name stands together in a tool’s answer — never from parts far apart', async () => {
    const { session } = ledger()
    const far = `Alex Morgan leads sales at Carbonmaps. ${'Unrelated words about climate software. '.repeat(400)} Wei Chen joined in 2021.`
    session.addToolResult(EXA, mcp(far), { query: 'carbonmaps team' })
    expect(await session.find((t) => textNamesPerson(t, 'Alex', 'Chen'))).toEqual([])
    // Each name that does stand together is found, deep in the answer too.
    expect(await session.find((t) => textNamesPerson(t, 'Wei', 'Chen'))).toEqual([{ kind: 'tool', tool: EXA }])
    expect(await session.find((t) => textNamesPerson(t, 'Alex', 'Morgan'))).toEqual([{ kind: 'tool', tool: EXA }])
    // An address or a host anywhere in a long answer is still found.
    session.addToolResult(EXA, mcp(`${'filler words here. '.repeat(2_000)}write to hello@carbonmaps.io or visit carbonmaps.io`), {
      query: 'carbonmaps contact',
    })
    expect(await session.find((t) => textShowsEmail(t, 'hello@carbonmaps.io'))).toEqual([{ kind: 'tool', tool: EXA }])
    expect(await session.find((t) => textShowsDomain(t, 'carbonmaps.io'))).toEqual([{ kind: 'tool', tool: EXA }])
  })

  it('never counts a match a window makes by cutting a word or an address the whole answer does not show', async () => {
    const { session } = ledger()
    // Every window boundary is tried; only the whole answer's own addresses count.
    for (let pad = 0; pad < 12; pad++) {
      session.addToolResult(EXA, mcp(`${'x'.repeat(290 + pad)} rakash@farmley.com and maxalex chen`), { query: `q${pad}` })
    }
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
  })

  /**
   * check_contacts and get_replies reach outside too, but print the CRM's own
   * people beside what they read — and the people invented before
   * 2026-10-13 are still on file under those names.
   */
  it('never counts check_contacts or get_replies, which print the CRM’s own people', async () => {
    const { session } = ledger()
    session.addToolResult(
      'mcp__agency__check_contacts',
      mcp('1 person checked at rentman.io\n  Jessica Martinez (Founder) · id c-1 · email …@rentman.io'),
      { domain: 'rentman.io' },
    )
    session.addToolResult(
      'mcp__agency__get_replies',
      mcp('2026-10-12 09:14  auto_reply  Marcus Thompson at rundoo.ai · NOT handled · “Out of office”'),
      { limit: 5 },
    )
    expect(await session.find((t) => textNamesPerson(t, 'Jessica', 'Martinez'))).toEqual([])
    expect(await session.find((t) => textNamesPerson(t, 'Marcus', 'Thompson'))).toEqual([])
  })
})

describe('the call’s own input never comes back as seen', () => {
  it('strips a whole query the result echoes', async () => {
    const { session } = ledger()
    const query = 'akash@farmley.com founder of Farmley'
    session.addToolResult(EXA, mcp(`No results for "${query}".`), { query })
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
  })

  it('strips an address typed anywhere in the input, in any case and as %40', async () => {
    const { session } = ledger()
    session.addToolResult(
      'mcp__jina__search_web',
      mcp('Searched: AKASH@Farmley.com. Also akash%40farmley.com in a link.'),
      { query: 'is akash@farmley.com real', num: 5 },
    )
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
    expect(await session.find((t) => /akash%40farmley/i.test(t))).toEqual([])
  })

  it('strips a phone number typed in the input, however the result writes it', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp('Matches for 098765-43210 and (987) 654 3210'), { query: '+91 98765 43210' })
    expect(await session.find((t) => textShowsPhone(t, '+919876543210'))).toEqual([])
  })

  it('leaves a value the input did not carry, and a short option value standing inside a word', async () => {
    const { session } = ledger()
    session.addToolResult(
      EXA,
      mcp('Autodesk — https://autodesk.com · Mycompany — https://mycompany.in · contact: sales@mycompany.in'),
      { query: 'design software', type: 'auto', category: 'company' },
    )
    expect(await session.find((t) => textShowsDomain(t, 'autodesk.com'))).toEqual([{ kind: 'tool', tool: EXA }])
    expect(await session.find((t) => textShowsDomain(t, 'mycompany.in'))).toEqual([{ kind: 'tool', tool: EXA }])
    expect(await session.find((t) => textShowsEmail(t, 'sales@mycompany.in'))).toEqual([{ kind: 'tool', tool: EXA }])
  })

  it('never adds the input itself — a call that answers nothing shows nothing', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp(''), { query: 'akash@farmley.com' })
    session.addToolResult(EXA, { content: [] }, { query: 'akash@farmley.com' })
    expect(await session.find((t) => t.includes('akash'))).toEqual([])
  })

  /**
   * read_page answers with the address it read on its first line, and a page
   * names its own domain in its footer. Neither says the domain is the
   * business's: that is for its homepage to say, in the tool that adds it.
   */
  it('never lets a page vouch for the domain it was read from — a bare host or a whole URL', async () => {
    const { session } = ledger()
    session.addToolResult(
      'mcp__agency__read_page',
      mcp('“Domain for sale” — myrahspa-mumbai.co (status 200).\nmyrahspa-mumbai.co may be for sale. © www.myrahspa-mumbai.co'),
      { url: 'https://myrahspa-mumbai.co/' },
    )
    session.addToolResult('mcp__firecrawl__firecrawl_scrape', mcp('Welcome to farmley.in — shop.farmley.in'), {
      url: 'farmley.in/about',
    })
    expect(await session.find((t) => textShowsDomain(t, 'myrahspa-mumbai.co'))).toEqual([])
    expect(await session.find((t) => textShowsDomain(t, 'farmley.in'))).toEqual([])
  })

  it('strips a domain typed into a search wherever the results name it as a host', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp('Results for yummybites-delhi.co: https://www.yummybites-delhi.co/menu'), {
      query: 'is yummybites-delhi.co their site',
    })
    expect(await session.find((t) => textShowsDomain(t, 'yummybites-delhi.co'))).toEqual([])
  })

  it('leaves an address the result shows at a typed domain — that address is the result’s own', async () => {
    const { session } = ledger()
    // A domain search: the model typed the domain; the addresses are the connector's answer.
    session.addToolResult('mcp__hunter__domain_search', mcp('farmley.com: info@farmley.com, akash.gupta@farmley.com'), {
      domain: 'farmley.com',
    })
    expect(await session.find((t) => textShowsEmail(t, 'info@farmley.com'))).toEqual([
      { kind: 'tool', tool: 'mcp__hunter__domain_search' },
    ])
    expect(await session.find((t) => textShowsEmail(t, 'akash.gupta@farmley.com'))).toEqual([
      { kind: 'tool', tool: 'mcp__hunter__domain_search' },
    ])
  })

  /** A search page prints its query back decoded: `?q=akash%40farmley.com` as "akash@farmley.com". */
  it('strips what a server decodes out of a URL the model typed — %40, +, a slug, an entity, a full-width @', async () => {
    const { session } = ledger()
    session.addToolResult(
      'mcp__agency__read_page',
      mcp('“akash@farmley.com - Search” — 3 results for akash@farmley.com'),
      { url: 'https://duckduckgo.com/html/?q=%22akash%40farmley.com%22' },
    )
    session.addToolResult('mcp__agency__read_page', mcp('Search results for Alex Chen'), {
      url: 'https://www.example-directory.com/search?q=Alex+Chen',
    })
    session.addToolResult('mcp__agency__read_page', mcp('Nothing found for jessica martinez'), {
      url: 'https://www.example-directory.com/people/jessica-martinez',
    })
    session.addToolResult(EXA, mcp('You searched for dev@rundoo.ai'), { query: 'dev&#64;rundoo.ai' })
    session.addToolResult(EXA, mcp('You searched for sarah@toplinepro.com'), { query: 'sarah＠toplinepro.com' })
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
    expect(await session.find((t) => textNamesPerson(t, 'Alex', 'Chen'))).toEqual([])
    expect(await session.find((t) => textNamesPerson(t, 'Jessica', 'Martinez'))).toEqual([])
    expect(await session.find((t) => textShowsEmail(t, 'dev@rundoo.ai'))).toEqual([])
    expect(await session.find((t) => textShowsEmail(t, 'sarah@toplinepro.com'))).toEqual([])
  })

  it('strips a phone number typed as a JSON number, or with its digits spread out', async () => {
    const { session } = ledger()
    session.addToolResult('mcp__lookup__phone', mcp('Number 98765 43210 is a mobile in India'), { phone: 9876543210 })
    session.addToolResult(EXA, mcp('Calls from 080-2345-6789'), { query: 'who owns 080 2345 6789' })
    expect(await session.find((t) => textShowsPhone(t, '+919876543210'))).toEqual([])
    expect(await session.find((t) => textShowsPhone(t, '+918023456789'))).toEqual([])
  })

  /**
   * The hook strips synchronously, on the worker's one thread, and the input
   * is the model's: a host searched for with a backtracking pattern took 1.5 s
   * on 16,000 characters of `a.a.a…` and four times as long for each doubling.
   */
  it('strips in linear time, whatever the model types', () => {
    for (const q of ['a.'.repeat(60_000) + '1', '.-'.repeat(60_000) + 'a', '%4'.repeat(60_000), 'a@'.repeat(60_000)]) {
      const started = performance.now()
      stripEchoes('a.a a@b.co 1 1 1', { q })
      expect(performance.now() - started).toBeLessThan(2_000)
    }
  })

  it('does not read a result whose input makes more to strip than can be done cheaply', () => {
    const urls = Array.from({ length: 900 }, (_, i) => `https://host-${i}.example/path-one?q=value%20${i}`)
    expect(stripEchoes('anything', { urls })).toBeNull()
  })

  it('does not read a result whose input has more values than can be stripped', () => {
    const many = Array.from({ length: 1_200 }, (_, i) => `value-${i}`)
    expect(stripEchoes('anything', { many })).toBeNull()
  })

  it('replaces an echo with a break that no address reads across', () => {
    const out = stripEchoes('write to akash@farmley.com today', { q: 'akash@farmley.com' })
    expect(out).not.toContain('akash@farmley.com')
    expect(out).toContain('write to')
    expect(out).toContain('today')
  })
})

describe('the text of a tool’s answer', () => {
  it('reads MCP text blocks, a bare array, a string and nested objects — never a block’s type or an image', () => {
    expect(toolResponseText({ content: [{ type: 'text', text: 'Error: Unauthorized' }], isError: false })).toBe(
      'Error: Unauthorized',
    )
    expect(toolResponseText([{ type: 'text', text: 'a' }, { type: 'image', data: 'iVBORw0KGgo' }, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    )
    expect(toolResponseText('plain')).toBe('plain')
    expect(toolResponseText({ results: [{ title: 'Acme', url: 'https://acme.in' }] })).toBe('Acme\nhttps://acme.in')
  })

  it('stops at the cap and survives a cycle', () => {
    const loop: Record<string, unknown> = { text: 'x'.repeat(50) }
    loop['self'] = loop
    expect(toolResponseText(loop, 20)).toHaveLength(20)
  })
})

describe('the person’s earlier messages, read from the database', () => {
  let test: TestDb
  let db: AgencyDb
  let orgId: string
  let otherOrgId: string
  let sessionId: string
  let otherSessionId: string

  beforeEach(async () => {
    test = await migratedDb()
    db = drizzle(test.pg, { schema }) as unknown as AgencyDb
    const [org] = await db.insert(schema.orgs).values({ name: 'Agency' }).returning({ id: schema.orgs.id })
    const [other] = await db.insert(schema.orgs).values({ name: 'Rival' }).returning({ id: schema.orgs.id })
    orgId = org!.id
    otherOrgId = other!.id
    const users = await db
      .insert(schema.users)
      .values([
        { orgId, email: 'owner@agency.test', role: 'owner' },
        { orgId: otherOrgId, email: 'owner@rival.test', role: 'owner' },
      ])
      .returning({ id: schema.users.id, orgId: schema.users.orgId })
    const threads = await db
      .insert(schema.chatSessions)
      .values([
        { orgId, userId: users.find((u) => u.orgId === orgId)!.id, title: 'mine' },
        { orgId: otherOrgId, userId: users.find((u) => u.orgId === otherOrgId)!.id, title: 'theirs' },
      ])
      .returning({ id: schema.chatSessions.id, title: schema.chatSessions.title })
    sessionId = threads.find((t) => t.title === 'mine')!.id
    otherSessionId = threads.find((t) => t.title === 'theirs')!.id
  }, 30_000)

  afterEach(async () => {
    await test?.close()
  })

  it('counts what the person typed in an earlier turn — and not the assistant, the brief, or another org', async () => {
    await appendChatMessage(db, { orgId, sessionId, turnId: TURN, seq: 0, role: 'user', content: { text: 'Priya is at priya@lotusclinic.in' } })
    await appendChatMessage(db, { orgId, sessionId, turnId: TURN, seq: 1, role: 'assistant', content: { text: 'Maybe akash@farmley.com?' } })
    await appendChatMessage(db, {
      orgId, sessionId, turnId: TURN, seq: 2, role: 'user',
      content: { text: `${morningBriefPrompt({ localDate: '2026-10-13', timeZone: 'Asia/Kolkata', startedAt: new Date('2026-10-13T03:30:00Z') })}\nbrief@ours.example` },
    })
    await appendChatMessage(db, {
      orgId: otherOrgId, sessionId: otherSessionId, turnId: TURN, seq: 0, role: 'user', content: { text: 'rival@rival.example' },
    })

    const session = new ConversationLedgers().forSession({ db, orgId, sessionId })
    expect(await session.find((t) => textShowsEmail(t, 'priya@lotusclinic.in'))).toEqual([{ kind: 'person' }])
    expect(await session.find((t) => textShowsEmail(t, 'akash@farmley.com'))).toEqual([])
    expect(await session.find((t) => textShowsEmail(t, 'brief@ours.example'))).toEqual([])
    expect(await session.find((t) => textShowsEmail(t, 'rival@rival.example'))).toEqual([])
    // Another org asking about the same session id reads nothing of this one.
    const stranger = new ConversationLedgers().forSession({ db, orgId: otherOrgId, sessionId })
    expect(await stranger.find((t) => textShowsEmail(t, 'priya@lotusclinic.in'))).toEqual([])
  })

  it('reads them once, lazily — and counts the message added live as the turn starts', async () => {
    await appendChatMessage(db, { orgId, sessionId, turnId: TURN, seq: 0, role: 'user', content: { text: 'first: a@one.example' } })
    const select = vi.spyOn(db, 'select')
    const session = new ConversationLedgers().forSession({ db, orgId, sessionId })
    expect(select).not.toHaveBeenCalled()
    session.addPerson('second: b@two.example')
    expect(await session.find((t) => textShowsEmail(t, 'a@one.example'))).toEqual([{ kind: 'person' }])
    expect(await session.find((t) => textShowsEmail(t, 'b@two.example'))).toEqual([{ kind: 'person' }])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('answers from what it holds when the read fails, says so by class only, and tries again next time', async () => {
    const warn = vi.fn()
    let fail = true
    const failing = {
      select: (...a: unknown[]) => {
        if (fail) throw new Error('connection refused to 10.0.0.5 for priya@lotusclinic.in')
        return (db.select as (...x: unknown[]) => unknown)(...a)
      },
    } as unknown as AgencyDb
    await appendChatMessage(db, { orgId, sessionId, turnId: TURN, seq: 0, role: 'user', content: { text: 'priya@lotusclinic.in' } })
    const session = new ConversationLedgers({ log: { warn } }).forSession({ db: failing, orgId, sessionId })
    session.addPerson('live@now.example')
    expect(await session.find((t) => textShowsEmail(t, 'live@now.example'))).toEqual([{ kind: 'person' }])
    expect(await session.find((t) => textShowsEmail(t, 'priya@lotusclinic.in'))).toEqual([])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('priya')
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'Error' })
    fail = false
    expect(await session.find((t) => textShowsEmail(t, 'priya@lotusclinic.in'))).toEqual([{ kind: 'person' }])
  })
})

describe('the bounds', () => {
  it('reads one result to 200,000 characters and no further', async () => {
    const { session } = ledger()
    session.addToolResult(EXA, mcp(`${'x '.repeat(LEDGER_RESULT_MAX_CHARS / 2)} late@far.example`), { query: 'q' })
    expect(await session.find((t) => textShowsEmail(t, 'late@far.example'))).toEqual([])
  })

  it('keeps 2 MB of tool text a session, dropping the oldest first', async () => {
    const { session } = ledger()
    const filler = 'y'.repeat(LEDGER_RESULT_MAX_CHARS - 40)
    session.addToolResult(EXA, mcp(`first@old.example ${filler}`), { query: 'q' })
    const count = Math.ceil(LEDGER_TOOL_TEXT_MAX / LEDGER_RESULT_MAX_CHARS)
    for (let i = 0; i < count; i++) session.addToolResult(EXA, mcp(`${filler} n${i}`), { query: 'q' })
    session.addToolResult(EXA, mcp('newest@new.example'), { query: 'q' })
    expect(await session.find((t) => textShowsEmail(t, 'first@old.example'))).toEqual([])
    expect(await session.find((t) => textShowsEmail(t, 'newest@new.example'))).toEqual([{ kind: 'tool', tool: EXA }])
  })

  it('hands back the same ledger for a session, and another for another org or session', () => {
    const ledgers = new ConversationLedgers()
    const db = emptyDb()
    const a = ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })).toBe(a)
    expect(ledgers.forSession({ db, orgId: 'org-2', sessionId: 's-1' })).not.toBe(a)
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-2' })).not.toBe(a)
  })

  it('remembers 300 sessions, forgetting the least recently used', async () => {
    const ledgers = new ConversationLedgers()
    const db = emptyDb()
    const first = ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-0' })
    first.addPerson('first@zero.example')
    const second = ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })
    for (let i = 2; i < LEDGER_SESSIONS_MAX; i++) ledgers.forSession({ db, orgId: 'org-1', sessionId: `s-${i}` })
    // Using s-0 again makes s-1 the least recently used.
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-0' })).toBe(first)
    ledgers.forSession({ db, orgId: 'org-1', sessionId: 'one-more' })
    expect(ledgers.size).toBe(LEDGER_SESSIONS_MAX)
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-0' })).toBe(first)
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })).not.toBe(second)
  })

  it('forgets a session six hours after anything was last added to it', async () => {
    let now = new Date('2026-10-13T06:00:00Z')
    const ledgers = new ConversationLedgers({ now: () => now })
    const db = emptyDb()
    const session = ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })
    session.addToolResult(EXA, mcp('kept@five.example'), { query: 'q' })
    now = new Date(now.getTime() + LEDGER_IDLE_MS - 1)
    expect(ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })).toBe(session)
    now = new Date(now.getTime() + 2)
    const fresh = ledgers.forSession({ db, orgId: 'org-1', sessionId: 's-1' })
    expect(fresh).not.toBe(session)
    expect(await fresh.find((t) => textShowsEmail(t, 'kept@five.example'))).toEqual([])
  })
})
