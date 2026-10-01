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
 * The time beside a delivery is when the REPORT reached this deployment,
 * not when the handset took the message: the DoveSoft route reads no time
 * from a report (its format is not public, and a time with no zone would be
 * a guess — `readDlr`), so `recordSmsDelivery` stamps `delivered_at` on
 * receipt. DoveSoft batches reports and retries the ones it was refused, so
 * that can be hours later. The line says "Delivery reported", which is true
 * of the time it is printed beside; "Delivered to the handset · <time>"
 * dated the delivery by its report.
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
  /**
   * When the delivery report reached this deployment (`delivered_at`, stamped
   * on receipt) — at or after the handset took the message, never the
   * handset's own time. For the page to render in the viewer's zone.
   */
  readonly at: Date | null
}

export function deliveryLine(t: DeliveryFacts): DeliveryLine | null {
  if (t.direction !== 'out') return null
  switch (t.deliveryStatus) {
    case 'delivered':
      return { tone: 'ok', text: 'Delivery reported', at: t.deliveredAt }
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
