/**
 * Reading a sign-in link a person pasted (2026-10-09). Pure, with no `@/`
 * import, so `apps/web/test` reads it directly.
 *
 * Installed on an iPhone's home screen, the app is a window of its own with
 * its own cookies, and a link tapped in Mail opens in Safari — so the
 * session lands in Safari and the app stays signed out. The fix that needs
 * no server is to bring the link to the app: copy it from the email, paste
 * it here, and the app opens it itself, where its own cookie is set.
 *
 * The box navigates only to THIS app's own magic-link callback, so it can
 * never be talked into opening anything else — not another site, not
 * another path here, not a link with no token. A link is a bearer
 * credential (§2.3): this reads it in the browser and hands it to the
 * browser, and nothing here logs it or sends it anywhere else.
 */

/** Where Auth.js's email provider lands a magic link (providers/nodemailer, CLAUDE.md §6). */
export const SIGN_IN_CALLBACK_PATH = '/api/auth/callback/nodemailer'

/** Trailing characters a mail client or a sentence wraps round a link, which are never part of one here. */
const TRAILING = /[)\]>}.,;:!?'"’”]+$/

/**
 * The link to open, or null: the first http(s) URL in what was pasted —
 * which may be the link alone or a line of the email around it — when it is
 * this app's sign-in callback, on this app's own origin, carrying a token
 * and the address it was sent to.
 */
export function signInLinkFrom(pasted: string, origin: string): string | null {
  const found = /https?:\/\/[^\s<>"]+/i.exec(pasted)
  if (!found) return null
  let url: URL
  let here: URL
  try {
    url = new URL(found[0].replace(TRAILING, ''))
    here = new URL(origin)
  } catch {
    return null
  }
  if (url.origin !== here.origin) return null
  if (url.pathname !== SIGN_IN_CALLBACK_PATH) return null
  if (url.username || url.password) return null
  if (!url.searchParams.get('token') || !url.searchParams.get('email')) return null
  return url.toString()
}
