/**
 * The words around a proposal's share link — the team's, and the buyer's.
 *
 * In one pure module so the page, the accept route and the team's controls
 * say the same thing, and so `apps/web/test/proposal-buyer-view.test.ts` can
 * read every sentence a buyer might be shown and pin that none of them says
 * "stale", a score or a tier (§2.2). The buyer is told the proposal is being
 * re-verified; the reason is the team's business.
 *
 * No `server-only`, no `@/`: a test imports this.
 */

/** The team's side, above the controls. */
export const SHARE_EXPLAINER =
  'A link is a copy of this proposal behind an unguessable, revocable address. Create one only after you have sent the proposal — the link is not the send.'

/** Beside a freshly created link: it is the only time the address exists outside the recipient's hands. */
export const SHARE_SHOWN_ONCE =
  'Copy it now. Only a hash of the link is kept, so it cannot be shown again — if it is lost, revoke it and create another. Paste it into a message you write; nothing is sent from here.'

/** What the view count is and is not. */
export const SHARE_VIEWS_NOTE =
  'A view is one load of the page — the buyer’s, yours, or a link preview a mail client fetched. It says the link was opened, not that a person read it. No address or browser is recorded.'

/** Why the Create button is not offered, in the order the route would refuse. */
export function shareCreateBlocked(input: {
  readonly status: string
  readonly evidenceStale: boolean
  /** A newer successful scan of the company exists, so this proposal's is no longer the one quoted. */
  readonly evidenceSuperseded?: boolean
}): string | null {
  if (input.status === 'draft') {
    return 'Mark the proposal as sent first. A link is a copy of what you sent, not the send.'
  }
  if (input.status !== 'sent') {
    return `This proposal is ${input.status}, so no new link can be created. Existing links show it read-only.`
  }
  if (input.evidenceStale) {
    return 'Not while the evidence under this proposal is stale: re-verify before it appears in anything outbound. Re-scan the company and generate a fresh proposal.'
  }
  if (input.evidenceSuperseded) {
    return 'A newer scan exists — regenerate the proposal. Only the latest scan is quoted in anything outbound; generate a fresh proposal from it, mark it sent, and link that one.'
  }
  return null
}

/** A link's state as the team's list shows it. */
export function shareState(
  share: { readonly revokedAt: string | null; readonly expiresAt: string; readonly acceptedAt: string | null },
  now: Date,
): 'accepted' | 'revoked' | 'expired' | 'live' {
  if (share.acceptedAt) return 'accepted'
  if (share.revokedAt) return 'revoked'
  if (new Date(share.expiresAt).getTime() <= now.getTime()) return 'expired'
  return 'live'
}

// ---------------------------------------------------------------------------
// The buyer's side — never "stale", never a score, never a tier
// ---------------------------------------------------------------------------

export const BUYER_ACCEPT_HEADING = 'Accept this proposal'

export const BUYER_AUTHORITY = 'By accepting you confirm you are authorised to do so.'

/** The sentence under the heading: what is being accepted, and as of when. */
export function buyerBasis(companyDomain: string, reviewedOn: string): string {
  return `You are accepting the scope and pricing above, based on a review of ${companyDomain}'s public pages on ${reviewedOn}.`
}

export function buyerAccepted(orgName: string): string {
  return `Recorded. ${orgName} now sees this proposal as accepted.`
}

export const BUYER_CLOSED = {
  accepted: 'This proposal has been accepted.',
  declined: 'This proposal is closed.',
  withdrawn: 'This proposal has been withdrawn.',
  other: 'This proposal is closed.',
} as const

export function buyerClosed(status: string): string {
  return status === 'accepted' || status === 'declined' || status === 'withdrawn'
    ? BUYER_CLOSED[status]
    : BUYER_CLOSED.other
}

export function buyerReverifying(orgName: string): string {
  return `This proposal is being re-verified. Ask ${orgName} for an updated copy.`
}

/** What the accept route answers, by refusal. Nothing here echoes the request. */
export const BUYER_REFUSAL: Readonly<Record<
  'not_found' | 'revoked' | 'expired' | 'reverifying' | 'already_accepted' | 'decided' | 'blank_name' | 'too_large' | 'invalid' | 'unavailable',
  string
>> = {
  not_found: 'This link is not active.',
  revoked: 'This link is not active.',
  expired: 'This link has expired. Ask whoever sent it to you for a new one.',
  reverifying: 'This proposal is being re-verified. Ask whoever sent you this link for an updated copy.',
  already_accepted: 'This proposal has already been accepted.',
  decided: 'This proposal is closed.',
  blank_name: 'Please type your name.',
  too_large: 'That request is too large.',
  invalid: 'That request could not be read.',
  unavailable: 'This could not be recorded just now. Please try again in a few minutes.',
}
