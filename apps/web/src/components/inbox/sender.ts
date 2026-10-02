/**
 * Whose reply an /inbox row is, and where an answer to it goes (review
 * round 9).
 *
 * `handleInboundEmail` files a reply matched by References under the contact
 * OUR message went to, whoever answered it, and round 8 put `fromIsContact`
 * on every row. A colleague's stop was worded as theirs (`opted-out.ts`),
 * and the Slack notice already says "from somebody else on the thread" —
 * but every other colleague reply was still headlined under the contact's
 * name ("Priya Shah <sam@rentman.io>"), and the answer composer said
 * "Drafting resumes Priya Shah: their reply paused them", true of neither
 * half: it was Sam's reply that paused Priya, and the answer is addressed
 * through the contact (`recipientFor`, outreach.ts) — Priya's address on
 * file, not the From — so Sam's question would be answered by mailing Priya
 * with nothing on the screen saying so.
 *
 * The contact's own reply is worded exactly as before. Pure strings, no
 * `server-only` and no `@/` import, so `apps/web/test/inbox-view.test.ts`
 * pins them.
 */

export interface ReplySender {
  /** False when the reply came from another address than the contact it is filed under. */
  readonly fromIsContact: boolean
  /** The address it came from, as received. */
  readonly from: string | null
  /** The contact it is filed under, as the page names them; null when they are gone. */
  readonly contactName: string | null
  /** The contact's address on file — where an answer goes. */
  readonly contactEmail: string | null
}

/**
 * The row's headline for a reply from somebody else on the thread: the
 * sender, then who it is filed under. Null for the contact's own reply,
 * which keeps "<contact> <from>".
 */
export function colleagueHeadline(row: ReplySender): { readonly sender: string; readonly note: string } | null {
  if (row.fromIsContact || !row.from) return null
  return {
    sender: row.from,
    note: `another address on this thread, filed under ${row.contactName ?? 'a contact no longer in the CRM'}`,
  }
}

/** The answer composer's note: what drafting does, and — for a colleague's reply — where the answer goes. */
export function answerComposerNote(row: ReplySender): string {
  const name = row.contactName ?? 'them'
  const putBack =
    'If the draft is denied, or the answer fails or is refused when it would be sent, the pause ' +
    `${row.fromIsContact ? 'their' : 'this'} reply caused goes back on — unless somebody resumes them before then, ` +
    'or another answer to them is still waiting.'
  if (row.fromIsContact) {
    return (
      `Drafting resumes ${name}: their reply paused them in every campaign, and an approved answer to a paused ` +
      `person is refused. ${putBack}`
    )
  }
  return (
    `This answer goes to ${name}’s address on file${row.contactEmail ? ` (${row.contactEmail})` : ''}, not to ` +
    `${row.from ?? 'the address this reply came from'}${row.from ? ', the address this reply came from' : ''}. ` +
    `Drafting resumes ${name}: this reply, filed under them, paused them in every campaign, and an approved answer ` +
    `to a paused person is refused. ${putBack}`
  )
}

/** Said once an answer is drafted and the route resumed the contact. */
export function resumedLine(row: ReplySender): string {
  const name = row.contactName ?? 'They'
  return row.fromIsContact
    ? `${name} is resumed — their reply had paused them in every campaign.`
    : `${name} is resumed — the reply filed under them had paused them in every campaign.`
}
