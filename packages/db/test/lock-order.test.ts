/**
 * One lock order for the writers that hold a person and their messages:
 * the CONTACT before the TOUCH. Pinned by source, because PGlite is one
 * embedded session and cannot show two transactions waiting on each other.
 *
 * Review round 5, finding [13]. A reply (`recordInboundReply`), a bounce
 * (`outreachRecordBounce`) and a reclassify lock the contact — the pause,
 * the bounce mark, the inbound row's key-share on its contact — and then
 * cancel that person's waiting messages, an answer to their reply among
 * them. `denyDraft` locked the answer first (its UPDATE) and then, since
 * round 4 on every deny of an answer, the contact (`repauseForUnansweredReply`'s
 * `FOR UPDATE`). Reproduced by the verifier on a scratch Postgres 16 with
 * the real functions on two pools: "deadlock detected", and either the deny
 * answered a 500 or the reply rolled back — a DoveSoft STOP that lost took
 * the loud not-recorded path for an opt-out the retry then recorded.
 *
 * Now an answer's deny reads (never locks) the answer row, locks the reply's
 * contact, and only then UPDATEs the answer — and the one new writer this
 * round adds, `dispatchTouch`'s correction of a recovered answer
 * (`recordRecoveredSend`), takes the same order.
 *
 * Review round 6, [13] and [14]: four more writers held a touch while they
 * waited for its person, each against an erasure, which locks the person
 * and then scrubs every row of theirs (reproduced on Postgres 16). `settle`
 * UPDATEd an answer and then re-paused; the stuck-send recovery marked
 * every claim `failed` and then re-paused; the inbox's answer
 * (`replyQueueDraft`) and its reclassify locked the REPLY row and then the
 * contact. Each now takes the person first.
 *
 * Review round 8, [6]: the lock STRENGTH matters too. `holdEach` (sms.ts)
 * read a shared number's holders `FOR UPDATE` — the one row lock that
 * conflicts with the `FOR KEY SHARE` a foreign-key check takes — so
 * `approveDraft` re-pointing an email draft from one holder to another
 * (it holds the draft, and its FK check waits on the new holder) deadlocked
 * with a text from their number (the hold holds the holder, and its cancel
 * waits on the draft). Reproduced on Postgres 16: 40P01. Both of sms.ts's
 * holder locks are `FOR NO KEY UPDATE` now, which every writer of
 * `paused_reason` (an UPDATE of non-key columns) still conflicts with.
 *
 * Delete (2026-10-15): `contactDelete` locks the person, then removes their
 * drafts; `companyDelete` locks the company's people in id order, then the
 * company, then touches their messages — an erasure holds the person and
 * then renames the company, and a reply holds the person and then writes
 * rows naming it, so the company is never held while a person is awaited.
 * `campaignDelete` removes drafts and takes no person's lock at all, so it
 * cannot be the half of the cycle that holds a message and waits on a person.
 *
 * Review of the delete (2026-10-15): two refusals were read and not locked.
 * A "no" recorded while a contact's delete ran is the consent upsert's
 * `ON CONFLICT DO UPDATE` — no key changes, so it takes no lock on the
 * contact — and the cascade then took it; the person's consent rows are
 * locked now, whatever they say, after the person. And a company's won
 * deal, sent quote, sent proposal, recorded meeting outcome and "asked to
 * stop" call were read with a status filter, so a teammate's write landing
 * in between was cascaded away; those rows are locked now, whatever their
 * state, after the company and before any message. And a deal's delete
 * locked the deal before the meetings, proposals and tasks its SET NULL
 * rewrites, the opposite of the company's order — two deletes of one
 * company's records deadlocked; it locks them first now. The cycles left
 * (an INSERT into meetings, notes or quotes checks the company's key before
 * the person's; `approveDraft` locks a draft before its recipient) are
 * stated in deletes.ts and CLAUDE.md: Postgres aborts one side with 40P01,
 * and nothing is half-written.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const src = read('../src/outreach.ts')
const inbox = read('../src/inbox.ts')
const reconcile = read('../../../apps/agent/src/boot/reconcile.ts')
const sms = read('../src/sms.ts')
const deletes = read('../src/deletes.ts')

/** The body of one top-level function, comments stripped, so a comment naming a call cannot satisfy the test. */
function body(signature: string, file = src): string {
  const start = file.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const rest = file.slice(start)
  return rest
    .slice(0, rest.indexOf('\n}\n'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('contact before touch', () => {
  it('the helper locks the reply’s contact FOR UPDATE', () => {
    const helper = body('async function lockReplyContact(')
    expect(helper).toContain('.from(schema.contacts)')
    expect(helper.indexOf(".for('update')")).toBeGreaterThan(helper.indexOf('.from(schema.contacts)'))
    // The reply row is read, never locked: only the person is.
    expect(helper.match(/\.for\('update'\)/g)).toHaveLength(1)
  })

  it('denyDraft locks the contact before it UPDATEs the answer', () => {
    const deny = body('export async function denyDraft(')
    const lock = deny.indexOf('lockReplyContact(tx')
    const update = deny.indexOf('.update(schema.touches)')
    expect(lock).toBeGreaterThan(-1)
    expect(update).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(update)
    // …and in the same transaction as the UPDATE and the re-pause.
    expect(deny.indexOf('db.transaction(')).toBeLessThan(lock)
    expect(deny.indexOf('repauseForUnansweredReply(tx')).toBeGreaterThan(update)
    // The answer row itself is only read before the lock, never locked.
    expect(deny.slice(0, lock)).not.toContain(".for('update')")
  })

  it('the correction of a recovered answer locks the contact before it UPDATEs the row', () => {
    const recovered = body('async function recordRecoveredSend(')
    const lock = recovered.indexOf('lockReplyContact(tx')
    const update = recovered.indexOf('.update(schema.touches)')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(update)
    expect(recovered.indexOf('liftRecoveryPause(tx')).toBeGreaterThan(update)
  })

  it('settle locks the reply’s contact before it UPDATEs an answer it ends', () => {
    const settle = body('async function settle(')
    const tx = settle.indexOf('db.transaction(')
    const lock = settle.indexOf('lockReplyContact(tx')
    const write = settle.indexOf('await write(tx)')
    expect(tx).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(tx)
    expect(write).toBeGreaterThan(lock)
    expect(settle.indexOf('repauseForUnansweredReply(tx')).toBeGreaterThan(write)
  })

  it('several people are locked in one statement, in id order, and never their replies', () => {
    const helper = body('export async function lockReplyContacts(')
    const contacts = helper.indexOf('.from(schema.contacts)')
    expect(contacts).toBeGreaterThan(-1)
    expect(helper.indexOf('.orderBy(asc(schema.contacts.id))')).toBeGreaterThan(contacts)
    expect(helper.match(/\.for\('update'\)/g)).toHaveLength(1)
    expect(helper.indexOf(".for('update')")).toBeGreaterThan(helper.indexOf('.orderBy(asc(schema.contacts.id))'))
  })

  it('the stuck-send recovery reads the claims, locks the people, and only then writes the claims', () => {
    const recover = body('export async function recoverStuckSends(', reconcile)
    const find = recover.indexOf('findStuckRows(tx')
    const lock = recover.indexOf('lockReplyContacts(')
    const write = recover.indexOf('recoverStuckRows(tx')
    expect(find).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(find)
    expect(write).toBeGreaterThan(lock)
    expect(recover.indexOf('repauseForUnansweredReply(tx')).toBeGreaterThan(write)
    // The read takes no lock; the write is the only statement that does.
    const reader = body('async function findStuckRows(', reconcile)
    expect(reader).toContain('.select(')
    expect(reader).not.toContain('.for(')
    expect(reader).not.toContain('.update(')
    const writer = body('async function recoverStuckRows(', reconcile)
    expect(writer).toContain('.update(schema.touches)')
    // …and it writes only the rows read, still claimed.
    expect(writer).toContain('inArray(schema.touches.id')
    expect(writer).toContain('claimedBefore(bootAt)')
  })

  for (const [name, signature] of [
    ['the answer (replyQueueDraft)', 'export async function replyQueueDraft('],
    ['the reclassify', 'async function reclassifyOnce('],
  ] as const) {
    it(`${name} reads the reply, locks its contact, and only then locks the reply`, () => {
      const fn = body(signature, inbox)
      const contact = fn.indexOf('.from(schema.contacts)')
      expect(contact).toBeGreaterThan(-1)
      const contactLock = fn.indexOf(".for('update')", contact)
      expect(contactLock).toBeGreaterThan(contact)
      // The first lock taken is the person's: nothing before it locks a row.
      expect(fn.slice(0, contactLock)).not.toContain(".for('update')")
      // The reply was read before, to learn whose it is…
      expect(fn.slice(0, contact)).toContain('.from(schema.touches)')
      // …and is locked after, and checked to be theirs still.
      const replyLock = fn.indexOf(".for('update')", contactLock + 1)
      expect(replyLock).toBeGreaterThan(contactLock)
      expect(fn.slice(contactLock, replyLock)).toContain('.from(schema.touches)')
      expect(fn.slice(replyLock)).toMatch(/contactId !== /)
    })
  }

  it('the re-pause still re-takes the contact lock before it reads the log', () => {
    const repause = body('export async function repauseForUnansweredReply(')
    expect(repause.indexOf(".for('update')")).toBeGreaterThan(-1)
    expect(repause.indexOf(".for('update')")).toBeLessThan(repause.indexOf("'reply.answer_drafted'"))
  })

  it('a shared number’s holders are locked FOR NO KEY UPDATE, never FOR UPDATE, in id order, before their messages', () => {
    for (const signature of ['async function holdEach(', 'async function releaseEach(']) {
      const fn = body(signature, sms)
      const contacts = fn.indexOf('.from(schema.contacts)')
      expect(contacts, signature).toBeGreaterThan(-1)
      const order = fn.indexOf('.orderBy(schema.contacts.id)', contacts)
      expect(order, signature).toBeGreaterThan(contacts)
      expect(fn.indexOf(".for('no key update')", order), signature).toBeGreaterThan(order)
      // The one lock that waits on an FK check's key-share is gone, and no
      // other strength stands in for it.
      expect(fn, signature).not.toContain(".for('update')")
      expect(fn.match(/\.for\(/g), signature).toHaveLength(1)
    }
    // The hold cancels its holders' messages only after it holds them.
    const hold = body('async function holdEach(', sms)
    expect(hold.indexOf('.update(schema.touches)')).toBeGreaterThan(hold.indexOf(".for('no key update')"))
    // Easing touches no message at all.
    expect(body('async function releaseEach(', sms)).not.toContain('schema.touches')
  })

  it('the holders’ loud path locks one holder at a time FOR NO KEY UPDATE, and touches no message (review round 9)', () => {
    const hard = body('async function holdHard(', sms)
    expect(hard.indexOf('.from(schema.contacts)')).toBeGreaterThan(-1)
    expect(hard.indexOf(".for('no key update')")).toBeGreaterThan(hard.indexOf('.from(schema.contacts)'))
    expect(hard).not.toContain(".for('update')")
    expect(hard.match(/\.for\(/g)).toHaveLength(1)
    expect(hard).not.toContain('schema.touches')
    expect(hard).not.toContain('pauseContactOverriding')
  })
  it('a contact’s delete locks the person before it removes a message of theirs', () => {
    const fn = body('export async function contactDelete(', deletes)
    const contact = fn.indexOf('.from(schema.contacts)')
    const lock = fn.indexOf(".for('update')", contact)
    const drafts = fn.indexOf('.delete(schema.touches)')
    expect(contact).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(contact)
    expect(drafts).toBeGreaterThan(lock)
    // The person is the first and only row locked, inside the one transaction,
    // and nothing reads or writes a message before it.
    expect(fn.indexOf('inOne<')).toBeLessThan(lock)
    expect(fn.slice(0, lock)).not.toContain('schema.touches')
    expect(fn.match(/\.for\(/g)).toHaveLength(1)
  })

  it('a company’s delete locks its people, then the company, then removes their messages', () => {
    const fn = body('export async function companyDelete(', deletes)
    const people = fn.indexOf('.from(schema.contacts)')
    const peopleLock = fn.indexOf(".for('update')", people)
    const firstCall = fn.indexOf('await peopleOf()')
    const company = fn.indexOf('.from(schema.companies)')
    const companyLock = fn.indexOf(".for('update')", company)
    const drafts = fn.indexOf('.delete(schema.touches)')
    expect(peopleLock).toBeGreaterThan(people)
    // The people are locked, in id order, before the company is…
    expect(fn.slice(people, peopleLock)).toContain('.orderBy(asc(schema.contacts.id))')
    expect(firstCall).toBeGreaterThan(-1)
    expect(firstCall).toBeLessThan(company)
    expect(companyLock).toBeGreaterThan(company)
    // …and the company before any message is written.
    expect(drafts).toBeGreaterThan(companyLock)
    expect(fn.slice(0, companyLock)).not.toMatch(/\.(delete|update|insert)\(/)
  })

  it('a person’s consent rows are locked whatever they say, after the person, and a refusal is read in JS', () => {
    const fn = body('async function contactKeepReasons(', deletes)
    const consents = fn.indexOf('.from(schema.consents)')
    expect(consents).toBeGreaterThan(-1)
    const lock = fn.indexOf(".for('update')", consents)
    expect(lock).toBeGreaterThan(consents)
    // No filter on what the row says: a row turning from yes to no is waited for.
    expect(fn.slice(consents, lock)).not.toContain('schema.consents.granted')
    expect(fn.slice(consents, lock)).toContain('.orderBy(asc(schema.consents.id))')
    expect(fn).toContain("if (!c.granted) keep(c.contactId, 'refusal')")
    // It is the only lock the reasons take, and both deletes take the person first.
    expect(fn.match(/\.for\(/g)).toHaveLength(1)
    for (const writer of ['export async function contactDelete(', 'export async function companyDelete(']) {
      const w = body(writer, deletes)
      expect(w.indexOf(".for('update')"), writer).toBeLessThan(w.indexOf('contactKeepReasons(tx'))
    }
  })

  it('a company’s delete locks what decides it, whatever its state, after the company and before any message', () => {
    const fn = body('export async function companyDelete(', deletes)
    const companyLock = fn.indexOf(".for('update')", fn.indexOf('.from(schema.companies)'))
    const drafts = fn.indexOf('.delete(schema.touches)')
    expect(companyLock).toBeGreaterThan(-1)
    let at = companyLock
    // Quotes, proposals and meetings before deals: the order their writers take them.
    for (const table of ['quotes', 'proposals', 'meetings', 'tasks', 'deals']) {
      const from = fn.indexOf(`.from(schema.${table})`, at)
      expect(from, table).toBeGreaterThan(at)
      const lock = fn.indexOf(".for('update')", from)
      expect(lock, table).toBeGreaterThan(from)
      // Nothing between the table and its lock filters on the state the delete decides by.
      expect(fn.slice(from, lock), table).not.toMatch(/\.(status|stage|outcome|doneAt)\b/)
      expect(lock, table).toBeLessThan(drafts)
      at = lock
    }
    // …and none of them is read again with a status filter to decide.
    expect(fn).not.toMatch(/ne\(schema\.quotes\.status|eq\(schema\.deals\.stage|isNotNull\(schema\.meetings\.outcome|ne\(schema\.proposals\.status/)
    // The refusals are decided after the locks.
    for (const code of ["'deal_won'", "'quote_sent'", "'proposal_sent'", "'meeting_held'", "'call_record'"]) {
      expect(fn.indexOf(code), code).toBeGreaterThan(at)
    }
  })

  it('a deal’s delete locks the proposals, meetings and tasks naming it before the deal, as a company’s does', () => {
    const fn = body('export async function dealDelete(', deletes)
    const deal = fn.indexOf('.from(schema.deals)')
    const dealLock = fn.indexOf(".for('update')", deal)
    expect(deal).toBeGreaterThan(-1)
    let at = -1
    for (const table of ['proposals', 'meetings', 'tasks']) {
      const from = fn.indexOf(`.from(schema.${table})`, at + 1)
      expect(from, table).toBeGreaterThan(at)
      const lock = fn.indexOf(".for('update')", from)
      expect(lock, table).toBeGreaterThan(from)
      expect(fn.slice(from, lock), table).toContain(`.orderBy(asc(schema.${table}.id))`)
      expect(fn.slice(from, lock), table).toContain(`eq(schema.${table}.dealId, dealId)`)
      expect(lock, table).toBeLessThan(deal)
      at = lock
    }
    expect(dealLock).toBeGreaterThan(at)
    expect(fn.indexOf('.delete(schema.deals)')).toBeGreaterThan(dealLock)
    // The same order, child before deal, as the company's delete takes them.
    const company = body('export async function companyDelete(', deletes)
    const order = ['proposals', 'meetings', 'tasks', 'deals'].map((t) => company.indexOf(`.from(schema.${t})`))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a company’s delete locks every task of the company, not only calls and visits', () => {
    const fn = body('export async function companyDelete(', deletes)
    const from = fn.indexOf('.from(schema.tasks)')
    const lock = fn.indexOf(".for('update')", from)
    expect(fn.slice(from, lock)).not.toContain('schema.tasks.kind')
  })

  it('every delete locks what it removes before it writes anything, and a campaign’s locks no person', () => {
    const writers = [...deletes.matchAll(/^export async function (\w+Delete)\(/gm)].map((m) => m[1]!)
    expect(writers.sort()).toEqual([
      'campaignDelete', 'companyDelete', 'contactDelete', 'dealDelete', 'icpProfileDelete', 'meetingDelete',
      'proposalDelete', 'quoteDelete', 'taskDelete', 'templateDelete',
    ])
    for (const name of writers) {
      const fn = body(`export async function ${name}(`, deletes)
      const lock = fn.indexOf(".for('update')")
      expect(lock, name).toBeGreaterThan(-1)
      expect(fn.slice(0, lock), name).not.toMatch(/\.(delete|update|insert)\(/)
      // The audit row is in the same transaction, and never caught.
      expect(fn, name).toContain('appendAudit(tx,')
      expect(fn, name).not.toContain('.catch(')
    }
    expect(body('export async function campaignDelete(', deletes)).not.toContain('schema.contacts')
  })
})
