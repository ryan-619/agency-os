/**
 * What counts as somebody reading a business's link (2026-10-08). Pure, for
 * its test: no `server-only`, no `@/` import.
 *
 * A link pasted into WhatsApp, Slack or an email is fetched at once by the
 * app that builds its preview card, and a mail gateway may fetch every URL in
 * a message as it is delivered — each before anybody has read a word. Counted
 * from the page's GET, every such fetch would be "they just opened it", and
 * the first would raise a call task the moment the link was sent. So a view
 * is counted only by the page's own script, in a browser, once the page has
 * been visible for `VIEW_AFTER_MS` (`view-beacon.tsx`); and the route that
 * records it ignores a user agent that names itself a robot. A reader with
 * scripts off is not counted: a missed view costs a task, a counted robot
 * costs a phone call made on a false premise.
 */

/** How long the page must have been visible before a view counts. */
export const VIEW_AFTER_MS = 2_500

export const LINK_KINDS = ['quote', 'report', 'preview'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export function linkKindOf(value: unknown): LinkKind | null {
  return typeof value === 'string' && (LINK_KINDS as readonly string[]).includes(value) ? (value as LinkKind) : null
}

/**
 * A user agent that says it is not a person: crawlers, preview fetchers,
 * headless browsers, command-line clients. Most preview fetchers run no
 * script and never reach the route at all; this is the second layer, for the
 * ones that do. It names robots only, so a real browser — an app's in-app
 * one included — is never mistaken for one.
 */
export const ROBOT_AGENT =
  /bot\b|bot\/|crawler|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl\/|wget\/|python-|okhttp|go-http-client|java\/|node-fetch|axios\//i

export function isRobotAgent(userAgent: string | null): boolean {
  return userAgent === null || userAgent.trim() === '' || ROBOT_AGENT.test(userAgent)
}
