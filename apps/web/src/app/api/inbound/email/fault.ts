import {
  keepingRolledBackOptOut, looksLikeOptOut, rolledBackOptOutAlarm, rolledBackOptOutAudit, rolledBackOptOutPause,
  type InboundLog, type RolledBackOptOut,
} from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * `POST /api/inbound/email` when recording the mail THREW — a dropped
 * connection, a statement timeout (review round 5).
 *
 * The route called `handleInboundEmail` with no try/catch, so a fault
 * escaped to Next as drizzle's error, whose message quotes every bound
 * parameter — the From address, the subject and up to 20,000 characters of
 * the reply — and Next logs an escaping error whole, past `redact()`, on
 * every retry. It is caught where it is thrown now, as the Resend and
 * DoveSoft routes catch theirs: the line names the fault's CLASS only, and
 * the answer is a 500 so the provider retries. `recordInboundReply` is one
 * transaction, so nothing about the reply was stored and the retry records
 * all of it.
 *
 * And a reply that asked to stop takes the loud path, as a text whose
 * recording failed does on DoveSoft's route: §2.1's Phase 4 obligation
 * does not wait for a retry that may fail the same way. Whose it was comes
 * from the recorder itself — its rolled-back line names the org and the
 * contact it was filing under (`keepingRolledBackOptOut`), so nothing is
 * read again from a database that just failed, and nothing re-decides what
 * the words meant. With that: the contact PAUSED over any earlier reason
 * (`pauseContactOverriding`, `opt-out not recorded: reply <ISO>
 * (record_failed)`), a `contact.opt_out_not_recorded` row naming the
 * contact (what /compliance and the digest count, and what keeps /inbox
 * from drafting to them), the `opt_out_not_recorded` alarm AWAITED before
 * the answer, and the error line. The pause is review round 6's: the row
 * and the alarm told people, but the sender reads neither, so the contact's
 * approved follow-up went on the worker's next tick until a retry landed —
 * every other writer of that row pauses. Each write is tried on its own,
 * because the database may be the thing that failed.
 *
 * Unless the reply came from somebody else (review round 7): a reply
 * matched by References is filed under the contact our message went to,
 * whoever answered, and a colleague's "remove me" held that contact as an
 * opt-out nobody recorded — a pause no Resume lifts and a row /inbox reads
 * however old — for good, even once the retry suppressed the colleague.
 * The recorder's line says `fromIsContact`; when it is false the contact
 * is paused as by any reply (`pauseContact`, `replied <ISO>`, which keeps
 * a stronger pause), and the row and the alarm are about the message the
 * sender answered and say whose address to record (inbound-fault.ts).
 *
 * A fault before the recorder ran — the duplicate check or the match
 * itself — leaves nothing saying whose it was: the words are read with the
 * reply's own opt-out reader, and a stop is said at error with `alarm:
 * 'not_raised_unplaced'`, because an alarm needs an org to be filed under
 * and guessing one is the mistake the matcher exists not to make. Nobody
 * is paused on a guess either.
 *
 * The reading of the recorder's line, and the shape of the pause, the row
 * and the alarm, live in packages/db (`inbound-fault.ts`), because the
 * worker's IMAP inbox takes the same path for the same fault; re-exported
 * here for the route.
 *
 * Kept beside the route, with no `server-only` and no `@/` import, so
 * `apps/web/test/inbound-email.test.ts` runs the route's own handling
 * against a real recorder and a real fault. The route itself reaches
 * `server-only` through `@/lib/db` and is pinned by reading its source.
 */
export { keepingRolledBackOptOut, type RolledBackOptOut }

export interface InboundEmailFaultDeps {
  readonly audit: (entry: {
    readonly orgId: string
    readonly actor: 'system'
    readonly action: 'contact.opt_out_not_recorded'
    readonly subjectType: 'contact' | 'touch' | null
    readonly subjectId: string | null
    readonly detail: Record<string, unknown>
  }) => Promise<void>
  /**
   * `pauseContactOverriding` on the route's database: true when the
   * contact's row took the pause. May throw; the caller says so.
   */
  readonly pause: (orgId: string, contactId: string, reason: string, now: Date) => Promise<boolean>
  /**
   * `pauseContact` on the route's database — a pause that keeps one already
   * there — for a stop from somebody other than the contact it was filed
   * under, who is held as by any reply. May throw; the caller says so.
   */
  readonly hold: (orgId: string, contactId: string, reason: string, now: Date) => Promise<boolean>
  /** Awaited: the opt-out alarm. Bounded and never throws (`notify`). */
  readonly alarm: (event: NotificationEvent) => Promise<void>
  readonly log: { error(message: string, fields?: Record<string, unknown>): void }
  /** For tests. Defaults to the wall clock. */
  readonly now?: () => Date
}

export interface InboundEmailFaultAnswer {
  readonly status: 500
  readonly body: Readonly<Record<string, unknown>>
}

/** The answer to a mail whose recording threw. Never throws itself. */
export async function inboundEmailNotRecorded(
  err: unknown,
  mail: { readonly text: string | null; readonly rolledBack: RolledBackOptOut | null },
  deps: InboundEmailFaultDeps,
): Promise<InboundEmailFaultAnswer> {
  // The CLASS of the fault, never its message: drizzle's quotes the address
  // and the words.
  const error = err instanceof Error ? err.name : 'UnknownError'
  const placed = mail.rolledBack
  if (placed) {
    // Held first, before anybody is told: the sender reads a pause, never
    // the audit row or the alarm.
    const now = deps.now ? deps.now() : new Date()
    const pause = rolledBackOptOutPause(placed, now)
    let paused: boolean
    try {
      paused = pause.overriding
        ? await deps.pause(placed.orgId, placed.contactId, pause.reason, now)
        : await deps.hold(placed.orgId, placed.contactId, pause.reason, now)
    } catch {
      paused = false
    }
    let audited = true
    try {
      await deps.audit(rolledBackOptOutAudit(placed))
    } catch {
      audited = false
    }
    deps.log.error('OPT-OUT NOT RECORDED — an email that asked to stop could not be recorded; answering 500 so the provider retries, otherwise follow up by hand', {
      error,
      orgId: placed.orgId,
      contactId: placed.contactId,
      // False: a colleague's stop, filed under that contact — who is held
      // as by a reply, not as the one who asked.
      fromIsContact: placed.fromIsContact,
      paused,
      audited,
      alarm: 'raised',
    })
    await deps.alarm(rolledBackOptOutAlarm(placed))
    return { status: 500, body: { error: 'opt-out not recorded', retry: true } }
  }
  if (looksLikeOptOut(mail.text)) {
    deps.log.error('OPT-OUT NOT RECORDED — an email that asked to stop could not be recorded, and nothing says whose it was; answering 500 so the provider retries', {
      error,
      alarm: 'not_raised_unplaced',
    })
    return { status: 500, body: { error: 'opt-out not recorded', retry: true } }
  }
  deps.log.error('inbound email could not be recorded; answering 500 so it is retried', { error })
  return { status: 500, body: { error: 'the message could not be recorded', retry: true } }
}

/**
 * The same loud path for a recorder another route calls — `POST
 * /api/inbound/resend`, whose reader (`receiveResendWebhook`) already
 * answers 500 on a fault so Resend retries, but raised no alarm and wrote no
 * row for a stop whose recording threw. This wraps the recorder: it hands
 * the recorder a log that keeps the rolled-back line, and on a throw takes
 * `inboundEmailNotRecorded`'s path (the pause, the row, the awaited alarm,
 * the error line naming the fault's class) before rethrowing, so the
 * reader's own 500 is unchanged.
 */
export function raisingOnFault<M extends { readonly text?: string | null; readonly log?: InboundLog }, O>(
  record: (mail: M) => Promise<O>,
  deps: InboundEmailFaultDeps & { readonly forward: InboundLog },
): (mail: M) => Promise<O> {
  return async (mail) => {
    const recorder = keepingRolledBackOptOut(deps.forward)
    try {
      return await record({ ...mail, log: recorder })
    } catch (err) {
      await inboundEmailNotRecorded(err, { text: mail.text ?? null, rolledBack: recorder.rolledBack() }, deps)
      throw err
    }
  }
}
