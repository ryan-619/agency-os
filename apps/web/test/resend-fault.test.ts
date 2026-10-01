/**
 * A stop received through Resend whose recording threw (review round 6).
 *
 * `receiveResendWebhook` answered 500 so Resend retries, and that was all: no
 * `contact.opt_out_not_recorded` row and no alarm, where the generic route
 * took the loud path for the same fault. `raisingOnFault` gives the Resend
 * route that path around its recorder; the route is pinned by reading its
 * source, because it reaches `server-only`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { InboundLog } from '@agency/db/queries'
import { raisingOnFault } from '../src/app/api/inbound/email/fault'
import type { NotificationEvent } from '../src/lib/slack-message'

function harness() {
  const audits: Record<string, unknown>[] = []
  const alarms: NotificationEvent[] = []
  const lines: { message: string; fields?: Readonly<Record<string, unknown>> }[] = []
  const log: InboundLog = { error: (message, fields) => lines.push({ message, fields }) }
  return {
    audits,
    alarms,
    lines,
    deps: {
      forward: log,
      log,
      audit: async (entry: Record<string, unknown>) => {
        audits.push(entry)
      },
      alarm: async (event: NotificationEvent) => {
        alarms.push(event)
      },
    },
  }
}

class DbFault extends Error {
  override name = 'DbFault'
}

describe('raisingOnFault', () => {
  it('audits and alarms a stop the recorder rolled back, then rethrows so the reader answers 500', async () => {
    const h = harness()
    const record = raisingOnFault(async (mail: { text: string | null; log?: InboundLog }) => {
      // What recordInboundReply says when its transaction rolls back.
      mail.log?.error('OPT-OUT NOT RECORDED — the reply was rolled back; a provider retry records it, otherwise follow up by hand', {
        orgId: 'org-1',
        contactId: 'contact-1',
        inReplyTo: 'touch-1',
        error: 'DbFault',
      })
      throw new DbFault('connection lost: priya@rentman.io said stop')
    }, h.deps)

    await expect(record({ text: 'Stop' })).rejects.toBeInstanceOf(DbFault)
    expect(h.audits).toEqual([
      expect.objectContaining({
        orgId: 'org-1',
        action: 'contact.opt_out_not_recorded',
        subjectType: 'contact',
        subjectId: 'contact-1',
        detail: { channel: 'email', why: 'record_failed' },
      }),
    ])
    expect(h.alarms).toEqual([
      { kind: 'opt_out_not_recorded', orgId: 'org-1', touchId: 'touch-1', contactId: 'contact-1', path: 'reply' },
    ])
    // The fault's class, never its message (which quotes the address).
    expect(JSON.stringify(h.lines)).not.toContain('priya@rentman.io')
  })

  it('raises no alarm for an ordinary reply whose recording threw, and still rethrows', async () => {
    const h = harness()
    const record = raisingOnFault(async (_mail: { text: string | null; log?: InboundLog }) => {
      throw new DbFault('timeout')
    }, h.deps)
    await expect(record({ text: 'Thanks, talk in January.' })).rejects.toBeInstanceOf(DbFault)
    expect(h.alarms).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('passes a recorded outcome straight through', async () => {
    const h = harness()
    const record = raisingOnFault(async (_mail: { text: string | null; log?: InboundLog }) => ({ matched: 'none' as const }), h.deps)
    await expect(record({ text: 'hello' })).resolves.toEqual({ matched: 'none' })
    expect(h.alarms).toEqual([])
  })

  it('is what the Resend route records through', () => {
    const src = readFileSync(new URL('../src/app/api/inbound/resend/route.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/handle: raisingOnFault\(\(mail\) => handleInboundEmail\(/)
    expect(src).toMatch(/alarm: \(event\) => notify\(event\)/)
  })
})
