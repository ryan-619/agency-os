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
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/outreach.ts', import.meta.url)), 'utf8')

/** The body of one top-level function, comments stripped, so a comment naming a call cannot satisfy the test. */
function body(signature: string): string {
  const start = src.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const rest = src.slice(start)
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

  it('the re-pause still re-takes the contact lock before it reads the log', () => {
    const repause = body('export async function repauseForUnansweredReply(')
    expect(repause.indexOf(".for('update')")).toBeGreaterThan(-1)
    expect(repause.indexOf(".for('update')")).toBeLessThan(repause.indexOf("'reply.answer_drafted'"))
  })
})
