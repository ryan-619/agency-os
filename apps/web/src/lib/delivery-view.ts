/**
 * What a delivery report says about one outbound SMS (0019), as the
 * company page's Conversation panel prints it.
 *
 * `touches.delivery_status` is written by `recordSmsDelivery` alone, from
 * DoveSoft's report, and `status` is never moved by it: a message the
 * operator accepted is `sent` whatever the handset did. So the report is its
 * own line beside the status, and NULL — no report has come, which is every
 * email and LinkedIn message and any text whose report never arrived — says
 * nothing rather than guessing.
 *
 * A failed delivery is evidence about a NUMBER on one attempt, not a person
 * asking to be left alone (0019, as a bounce is not, 0018), and the line
 * says so, because "not delivered" next to a person's name reads like a no.
 *
 * Pure, and imported by a test: no `server-only`, no `@/`.
 */
export interface DeliveryFacts {
  readonly direction: string
  readonly deliveryStatus: string | null
  readonly deliveredAt: Date | null
  readonly deliveryError: string | null
}

export interface DeliveryLine {
  readonly tone: 'ok' | 'warn' | 'plain'
  readonly text: string
  /** The handset's time, for the page to render in the viewer's zone. */
  readonly at: Date | null
}

export function deliveryLine(t: DeliveryFacts): DeliveryLine | null {
  if (t.direction !== 'out') return null
  switch (t.deliveryStatus) {
    case 'delivered':
      return { tone: 'ok', text: 'Delivered to the handset', at: t.deliveredAt }
    case 'pending':
      return { tone: 'plain', text: 'The operator has it; no final delivery report yet.', at: null }
    case 'failed':
      return {
        tone: 'warn',
        text:
          `Not delivered${t.deliveryError ? `: ${t.deliveryError}` : ''}. ` +
          'A failed delivery is about the number on this attempt; it suppresses nobody.',
        at: null,
      }
    default:
      // NULL, or a value outside 0019's CHECK — which cannot be stored, and
      // is not guessed at if it ever is.
      return null
  }
}
