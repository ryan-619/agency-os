/**
 * A shared number's holder, as every screen with a Resume button words them
 * (review round 9).
 *
 * When a STOP texted from a number several contacts hold could not be
 * recorded, every holder but the one it was filed under is paused
 * `opt-out not recorded: a text from a number they share, <ISO> (<why>)`
 * (`sharedNumberOptOutReason`, packages/db/src/sms.ts). `pauseReasonClass`
 * reads that as `opt_out_not_recorded` by its opening words, and /contacts
 * branched on the class alone: the holder — who may have sent nothing — was
 * said to have "asked to stop", told "the pause stays", and offered no
 * Resume, while `contactResumeByHand` lifts exactly this pause once the
 * number is on the suppression list, and its refusal (RESUME_SHARED_NUMBER),
 * `check_send` and /settings/deployment all send a person to /contacts to
 * lift it. Three readers of one row disagreed.
 *
 * So the shape is readable on the client: `isSharedNumberOptOutPause` is
 * the database package's own predicate, restated — a client component must
 * not import `@agency/db`, which carries the driver — and
 * `apps/web/test/shared-number-pause.test.ts` holds the two to one answer
 * over a set of reasons, the asker's own and the writers' real output
 * included. Pure, with no `server-only` and no `@/` import, so that test can
 * import it.
 */

/** packages/db/src/sms.ts's `SHARED_NUMBER_OPT_OUT`, character for character. */
const SHARED_NUMBER_OPT_OUT = /^opt-out not recorded: a text from a number they share, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \([^()]*\)$/

/** Is this pause `sharedNumberOptOutReason`'s, and nothing else's? Matched in full, as the database package matches it. */
export function isSharedNumberOptOutPause(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && SHARED_NUMBER_OPT_OUT.test(reason)
}

/**
 * What a row offers for a pause: Resume; Resume once the shared number is
 * recorded (`record_number`); or no Resume, because the pause stands for the
 * contact's OWN opt-out nobody could record (`opt_out_not_recorded`) or an
 * erasure that did not finish (`erasure`). Null when they are not paused.
 *
 * `pausedFor` is `pauseReasonClass(reason)` — taken as an argument so this
 * file imports nothing. `record_number` still renders Resume: the route
 * refuses it with RESUME_SHARED_NUMBER's sentence until the number is
 * recorded, and lifts it after, so the button and the server agree.
 *
 * `sharedNumberHold` is the database's answer for this row
 * (`consentLedgerFor`, review round 10, [2]): a holder whose OWN pause — a
 * teammate's, an unsubscribe's — stood instead of the hold has that pause's
 * shape, and read by the shape alone got a plain Resume the route then
 * refused (RESUME_SHARED_NUMBER_KEPT). With it, their row says what lifts
 * it, as the hold's own shape does. Omitted: the shape alone decides, as
 * before, on the screens that do not read it.
 */
export type ResumeOffer = 'resume' | 'record_number' | 'opt_out_not_recorded' | 'erasure'

export function resumeOfferFor(
  pausedFor: string | null,
  reason: string | null | undefined,
  sharedNumberHold?: boolean,
): ResumeOffer | null {
  if (pausedFor === null) return null
  if (pausedFor === 'opt_out_not_recorded') return isSharedNumberOptOutPause(reason) ? 'record_number' : 'opt_out_not_recorded'
  if (pausedFor === 'erasure') return 'erasure'
  return sharedNumberHold === true ? 'record_number' : 'resume'
}

/** Does this offer render a Resume button? */
export function offersResume(offer: ResumeOffer | null): boolean {
  return offer === 'resume' || offer === 'record_number'
}

/**
 * Said beside such a holder's Resume, in three parts so the middle one can be
 * a link. It never says they asked to stop — they may not have — and it
 * names the fix the route checks for: the number on the suppression list.
 */
export const SHARED_NUMBER_HOLDER_WORDS = {
  lead:
    'A text from a number they share asked to stop, and it could not be recorded — they may not have sent it. ' +
    'Record the number on ',
  link: '/suppressions',
  tail: ', then Resume; until the number is recorded there, Resume is refused.',
} as const

/** The same words as one line. */
export const SHARED_NUMBER_HOLDER_NOTE =
  SHARED_NUMBER_HOLDER_WORDS.lead + SHARED_NUMBER_HOLDER_WORDS.link + SHARED_NUMBER_HOLDER_WORDS.tail

/**
 * Said before the number itself, beside the note, on the screens that list
 * paused people without their record — /suppressions and /inbox (review
 * round 10, [7]). The note says to record "the number"; those screens
 * showed none, so a holder imported with a phone and no email was a bare id
 * beside an instruction nobody could follow from there. The number is the
 * one on their record, which /contacts and the company page already show.
 */
export const SHARED_NUMBER_LABEL = 'The number they share:'
