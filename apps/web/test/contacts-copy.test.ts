/**
 * What /contacts says about pauses when nothing configured here reads a reply.
 *
 * The page appended "Until that changes, nobody here is paused by a reply —
 * only by hand." to `noRepliesReadNote`. `noRepliesReadNote` is a statement
 * about CONFIGURATION (round 3, finding [20]; reworded in round 4): a worker
 * on another host reads the mailbox against this database whether or not
 * this web half holds AGENT_URL, and a text a contact sends back through
 * DoveSoft's webhook pauses them through `recordInboundReply` with no worker
 * at all. So the sentence beside it is configuration too, and it points at
 * the page that shows both. The page imports `server-only` modules, so it is
 * read from the source, whitespace collapsed.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { noRepliesReadNote, type Deployment } from '../src/lib/deployment-facts'

const page = readFileSync(fileURLToPath(new URL('../src/app/contacts/page.tsx', import.meta.url)), 'utf8')
  .replace(/\s+/g, ' ')

const BARE: Deployment = {
  worker: false, mailIsLocalSink: false, inbound: 'none', cron: false, slack: false, unsubscribe: false,
}

describe('the pause note on /contacts', () => {
  it('no longer claims that nobody is paused by a reply', () => {
    expect(page).not.toContain('nobody here is paused by a reply')
    expect(page).not.toContain('Until that changes')
  })

  it('states the configuration, names the two other ways a reply pauses somebody, and points at /settings/deployment', () => {
    expect(page).toContain(
      '{repliesNote ? <> {repliesNote} As configured, this deployment pauses nobody on an email reply — a worker ' +
        'running elsewhere can, and a text reply through DoveSoft’s webhook does where that is set up; ' +
        '/settings/deployment shows both.</> : null}',
    )
  })

  it('sits beside a note that is itself about configuration, and only when that note is shown', () => {
    const note = noRepliesReadNote(BARE)
    expect(note).toContain('No worker is configured on this deployment')
    expect(note).toContain('/settings/deployment')
    expect(noRepliesReadNote({ ...BARE, worker: true })).toBeNull()
    expect(noRepliesReadNote({ ...BARE, inbound: 'webhook' })).toBeNull()
  })

  it('is right that a DoveSoft text pauses a contact without a worker', () => {
    const sms = readFileSync(fileURLToPath(new URL('../../../packages/db/src/sms.ts', import.meta.url)), 'utf8')
    expect(sms).toContain('recordInboundReply')
    const route = readFileSync(fileURLToPath(new URL('../src/app/api/inbound/dovesoft/sms/route.ts', import.meta.url)), 'utf8')
    expect(route).toContain('record: (args) => recordInboundSms(db, args)')
  })
})
