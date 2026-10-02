/**
 * What /inbox says beside a reply that asked to stop — and WHOSE stop it was
 * (review round 8).
 *
 * `handleInboundEmail` files a reply matched by References under the contact
 * OUR message went to, whoever answered it. When a colleague on the thread
 * replied all "please remove me from your list", the row read "Priya Shah
 * asked to stop — do not answer", and its missing-suppression warning was
 * cleared by suppressing Priya's address: a teammate following the screen
 * suppressed somebody who never asked, while the sender stayed unrecorded
 * and /compliance went on listing the reply. The row now carries
 * `fromIsContact` (`replyIsFromTheContact`, the comparison
 * `recordInboundReply` makes) and its `suppressed` is read by the address
 * the reply came from alone, so a colleague's stop is worded as round 7's
 * alarm words it: the address to record is THAT one, never the contact's.
 *
 * The contact's own stop is worded exactly as before, by `inbox-view.ts`.
 * Pure strings, no `server-only` and no `@/` import, so
 * `apps/web/test/inbox-view.test.ts` pins them.
 */
import { OPTED_OUT_NOTE, OPTED_OUT_NOT_SUPPRESSED_NOTE } from '../../lib/inbox-view'

export interface OptedOutRow {
  /** False when the reply came from another address than the contact it is filed under. */
  readonly fromIsContact: boolean
  /** The address it came from, as received. */
  readonly from: string | null
  /** The contact it is filed under, as the page names them; null when they are gone. */
  readonly contactName: string | null
  /** Whether a suppression row matches the address it came from. */
  readonly suppressed: boolean
}

/** The line under an opted-out reply. Followed on the page by a link to the suppression list. */
export function optedOutNote(row: OptedOutRow): string {
  const name = row.contactName ?? 'This person'
  if (row.fromIsContact) return `${name} ${OPTED_OUT_NOTE}`
  return (
    `A reply from another address on this thread${row.from ? ` (${row.from})` : ''} asked to stop — do not answer ` +
    `it. ${name} did not ask, and is not treated as the one who asked; the address on the suppression list must be ` +
    'the one the reply came from.'
  )
}

/** The warning when no suppression row matches the address the stop came from. Null when one does. */
export function optedOutWarning(row: OptedOutRow): string | null {
  if (row.suppressed) return null
  if (row.fromIsContact) return OPTED_OUT_NOT_SUPPRESSED_NOTE
  const name = row.contactName ?? 'the contact'
  return (
    `This reply asked to stop, but no suppression row matches the address it came from${
      row.from ? ` (${row.from})` : ''
    }, which is not ${name}’s. Record THAT address on the suppressions page — never ${name}’s: recording theirs ` +
    `does not record this opt-out. Until it is recorded, ${name} cannot be resumed or answered.`
  )
}
