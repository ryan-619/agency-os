/**
 * The free website check's words (2026-10-08), shared by the form and the
 * route — the consent row records exactly what the visitor saw, as the
 * booking page's does (`booking-copy.ts`). Pure: no `server-only`, no `@/`.
 */
export function checkConsentWording(agency: string): string {
  return `Email me about the result. ${agency} may contact me by email about my website check; I can ask them to stop at any time.`
}

/**
 * What a visitor reads when no page opens: a site or an address already on
 * file, where a person confirms who asked before anything is sent, or a page
 * that could not be made. True of both, and the same words for both.
 */
export const CHECK_THANKS = 'Thank you — we have your request, and we will be in touch about your website.'
