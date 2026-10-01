import type { BookingOutcome } from '@agency/db/queries'
import type { NotificationEvent } from '../../../../lib/slack-message'

/**
 * The Slack event an accepted booking announces — or null for a refused one,
 * where nothing was written.
 *
 * Beside the route, and free of `server-only` and `@/`, for the reason
 * `../../inbound/email/notification.ts` gives: the test runs this, so it
 * pins what the route actually builds.
 *
 * The booking request carried a name, an address, a phone number, free-text
 * notes and a chosen time. NONE of it is here, and not because a later
 * reader might forget: the outcome does not carry them, and the fields below
 * are named one by one. The meeting id is safe to post because it goes to
 * the team, never back to the visitor (the route returns `{ ok: true }`).
 */
export function bookingNotification(r: BookingOutcome): Extract<NotificationEvent, { kind: 'booking' }> | null {
  if (!r.ok) return null
  return {
    kind: 'booking',
    orgId: r.orgId,
    meetingId: r.meetingId,
    companyDomain: r.companyDomain,
    needsReview: r.needsReview,
  }
}
