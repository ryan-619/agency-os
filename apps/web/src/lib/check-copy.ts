/**
 * The free website check's words (2026-10-08), shared by the form and the
 * route — the consent row records exactly what the visitor saw, as the
 * booking page's does (`booking-copy.ts`). Pure: no `server-only`, no `@/`.
 */
export function checkConsentWording(agency: string): string {
  return `Email me about the result. ${agency} may contact me by email about my website check; I can ask them to stop at any time.`
}
