/**
 * The words on the public booking form (PROMPT.md §8.6, §2.1).
 *
 * In one place because the form SHOWS them and the API RECORDS them: the
 * consent rows the booking writes carry this exact wording as evidence of
 * what the visitor agreed to. If the page and the route each had their own
 * copy, the evidence would drift from the screen — and a consent whose
 * recorded wording is not what the person saw is a claim, not a consent.
 */
export const BOOKING_CONSENT_WORDING =
  'By requesting a meeting you agree that we may email you about it. ' +
  'If you add a phone number and tick the boxes below, you agree that we may also ' +
  'text or call you on that number about this request. You can ask us to stop at any time.'

export const BOOKING_CONSENT_CHANNELS = [
  { key: 'sms', label: 'You may text me about this request' },
  { key: 'voice', label: 'You may call me about this request' },
  { key: 'whatsapp', label: 'You may message me on WhatsApp about this request' },
] as const
