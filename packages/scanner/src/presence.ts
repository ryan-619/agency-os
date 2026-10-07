/**
 * Twelve WEBSITE-PRESENCE signals (2026-10-08): what a visitor, a phone and a
 * search engine find on a business's homepage — the questions an agency that
 * builds, fixes and promotes websites asks before it offers to.
 *
 * Informational, exactly as additive.ts's thirteen are: read from the bytes
 * the scanner already captured (no new request), unscored unless a profile
 * promotes one, and governed by §2.2 the same way, because a finding that is
 * not scored is still a statement about somebody's site:
 *   * an ABSENCE ("no viewport tag", "no WhatsApp link") is claimed only from
 *     a page the walk read to its end (`PageFacts.complete`) and that was not
 *     cut at the read cap — anything less is unobserved, never a gap;
 *   * a contact link is COUNTED, never kept: a `tel:` or `mailto:` value is a
 *     person's number or address, and findings are shown and exported;
 *   * nothing here reads a clock — the copyright year is judged against the
 *     capture's own date, so a fixture reads the same forever;
 *   * every observation carries a non-empty evidence object, and every
 *     unobserved one `gap: null` (`findings_unobserved_has_no_gap`).
 * Pure.
 */
import type { Observation } from '@agency/core'
import type { HtmlFacts, PageFacts } from './html.js'
import { pyHead } from './pystr.js'
import type { RawCapture } from './types.js'

export const PRESENCE_SIGNAL_KEYS = Object.freeze([
  'mobile_viewport', 'page_title', 'meta_description', 'social_preview', 'structured_data',
  'contact_options', 'whatsapp_chat', 'analytics_tags', 'social_profiles', 'site_platform',
  'copyright_year', 'booking_or_store',
] as const)

export type PresenceKey = (typeof PRESENCE_SIGNAL_KEYS)[number]

const DETAIL_MAX = 160

function observation(observed: boolean, gap: boolean | null, detail: string, evidence: Record<string, unknown>): Observation {
  return { observed, gap: observed ? Boolean(gap) : null, detail: pyHead(detail, DETAIL_MAX), evidence }
}

function notApplicable(why: string, evidence: Record<string, unknown>): Observation {
  return observation(true, false, `not applicable — ${why}`, evidence)
}

/** Why an absence read off this page would not be a reading, or null when it would. */
function unread(raw: RawCapture, page: PageFacts): string | null {
  if (raw.home.truncated === true) return 'not assessed — the homepage was longer than the scanner reads'
  if (!page.complete) return 'not assessed — the homepage could not be read to its end'
  return null
}

/** An absence, when the page was read whole; unobserved otherwise. */
function absent(raw: RawCapture, page: PageFacts, detail: string, evidence: Record<string, unknown>): Observation {
  const why = unread(raw, page)
  return why ? observation(false, null, why, evidence) : observation(true, true, detail, evidence)
}

function hostOf(ref: string, base: string): string | null {
  try {
    return new URL(ref.trim(), base).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function hostIs(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/** Every host the page loads a script or a resource from. */
function loadedHosts(facts: HtmlFacts, url: string): string[] {
  const hosts = new Set<string>()
  for (const s of facts.scriptTags) if (!s.inNoscript) {
    const h = hostOf(s.src, url)
    if (h) hosts.add(h)
  }
  for (const r of facts.resourceRefs) {
    const h = hostOf(r.url, url)
    if (h) hosts.add(h)
  }
  return [...hosts]
}

/** Every URL the page loads, lower-cased, for path markers like /wp-content/. */
function loadedUrls(facts: HtmlFacts): string[] {
  return [...facts.scriptTags.map((s) => s.src), ...facts.resourceRefs.map((r) => r.url)].map((u) => u.toLowerCase())
}

// ---------------------------------------------------------------------------

function mobileViewport(raw: RawCapture, page: PageFacts, url: string): Observation {
  const evidence = { url, viewport: page.viewport ?? 'absent' }
  if (page.viewport !== null) {
    if (/width\s*=\s*device-width|initial-scale\s*=\s*1(?:\.0+)?\b/i.test(page.viewport)) {
      return observation(true, false, 'set for phones (width=device-width)', evidence)
    }
    return observation(true, true, `viewport is "${pyHead(page.viewport, 60)}", not sized to the phone's screen`, evidence)
  }
  return absent(raw, page, "no viewport tag: phones show the desktop layout, zoomed out", evidence)
}

/** Titles that say nothing about the business. Compared lower-cased, punctuation dropped. */
const GENERIC_TITLES = new Set([
  'home', 'homepage', 'home page', 'index', 'untitled', 'welcome', 'default', 'new page', 'document',
  'my site', 'my website', 'site title', 'website', 'just another wordpress site', 'react app', 'vite app',
])
const UNFINISHED_TITLE = /\b(coming soon|under construction|under maintenance|maintenance mode|launching soon)\b/i

function pageTitle(raw: RawCapture, page: PageFacts, url: string): Observation {
  const t = page.realTitle
  const evidence = { url, title: t === null ? 'absent' : pyHead(t, 120) }
  if (t === null) return absent(raw, page, 'no page title: search results and browser tabs show the address instead', evidence)
  if (t === '') return observation(true, true, 'the page title is empty', evidence)
  if (UNFINISHED_TITLE.test(t)) return observation(true, true, `the page title says "${pyHead(t, 60)}": the site may not be finished`, evidence)
  const norm = t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (GENERIC_TITLES.has(norm) || [...t].length < 4) {
    return observation(true, true, `the page title is just "${pyHead(t, 40)}", which says nothing about the business`, evidence)
  }
  return observation(true, false, `"${pyHead(t, 100)}"`, evidence)
}

function metaDescription(raw: RawCapture, page: PageFacts, url: string): Observation {
  const d = page.description
  const length = d === null ? null : [...d].length
  const evidence = { url, length }
  if (d === null) return absent(raw, page, 'no meta description: search results show whatever text the search engine picks', evidence)
  if (d === '') return observation(true, true, 'the meta description is empty', evidence)
  return observation(true, false, `set (${length} characters${length !== null && length < 50 ? ', short' : ''})`, evidence)
}

function socialPreview(raw: RawCapture, page: PageFacts, url: string): Observation {
  const og = page.openGraph
  const evidence = { url, openGraph: og }
  const titled = og.includes('og:title')
  const pictured = og.includes('og:image')
  if (titled || pictured) {
    return pictured
      ? observation(true, false, `link previews set (${og.slice(0, 4).join(', ')})`, evidence)
      : observation(true, true, 'a preview title but no image: a shared link shows no picture', evidence)
  }
  return absent(raw, page, 'no Open Graph tags: a link shared on WhatsApp or social media shows no preview card', evidence)
}

function structuredData(raw: RawCapture, page: PageFacts, url: string): Observation {
  const evidence = { url, blocks: page.structuredBlocks, types: page.structuredTypes }
  if (page.structuredBlocks > 0) {
    const types = page.structuredTypes.slice(0, 4)
    return observation(true, false, `structured data for search engines${types.length ? `: ${types.join(', ')}` : ''}`, evidence)
  }
  return absent(raw, page, 'no structured data telling search engines what the business is, where and when it opens', evidence)
}

function contactOptions(raw: RawCapture, page: PageFacts, url: string): Observation {
  // Counts only — never a number or an address (§2.3).
  const evidence = { url, phoneLinks: page.telLinks, emailLinks: page.mailtoLinks, whatsappLinks: page.whatsappLinks, forms: page.forms }
  const found = [
    page.telLinks > 0 ? 'a tap-to-call link' : null,
    page.mailtoLinks > 0 ? 'an email link' : null,
    page.whatsappLinks > 0 ? 'a WhatsApp link' : null,
    page.forms > 0 ? 'a form' : null,
  ].filter((f): f is string => f !== null)
  if (found.length > 0) return observation(true, false, `on the homepage: ${found.join(', ')}`, evidence)
  return absent(raw, page, 'no tap-to-call link, email link, WhatsApp link or form on the homepage', evidence)
}

function whatsappChat(raw: RawCapture, page: PageFacts, url: string): Observation {
  const evidence = { url, whatsappLinks: page.whatsappLinks }
  if (page.whatsappLinks > 0) return observation(true, false, 'a WhatsApp chat link on the homepage', evidence)
  return absent(raw, page, 'no WhatsApp chat link on the homepage', evidence)
}

/** Analytics and advertising tags, by where they load from. */
const TAG_HOSTS: readonly (readonly [name: string, host: string, path?: RegExp])[] = [
  ['Google Analytics', 'google-analytics.com'],
  ['Google Analytics', 'googletagmanager.com', /\/gtag\/js/],
  ['Google Tag Manager', 'googletagmanager.com', /\/gtm\.js|\/ns\.html/],
  ['Meta pixel', 'connect.facebook.net', /fbevents\.js/],
  ['Meta pixel', 'facebook.com', /\/tr\b/],
  ['Microsoft Clarity', 'clarity.ms'],
  ['Hotjar', 'static.hotjar.com'],
  ['LinkedIn Insight', 'snap.licdn.com'],
  ['Plausible', 'plausible.io'],
  ['Segment', 'cdn.segment.com'],
  ['Mixpanel', 'cdn.mxpnl.com'],
]
const MARKER_NAMES: Readonly<Record<string, string>> = {
  'google-tag-manager': 'Google Tag Manager',
  'google-analytics': 'Google Analytics',
  'meta-pixel': 'Meta pixel',
  'microsoft-clarity': 'Microsoft Clarity',
  hotjar: 'Hotjar',
  'linkedin-insight': 'LinkedIn Insight',
}

function analyticsTags(raw: RawCapture, facts: HtmlFacts, url: string): Observation {
  const found = new Set<string>()
  const refs = [...facts.scriptTags.filter((s) => !s.inNoscript).map((s) => s.src), ...facts.resourceRefs.map((r) => r.url)]
  for (const ref of refs) {
    let u: URL
    try {
      u = new URL(ref.trim(), url)
    } catch {
      continue
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    for (const [name, base, path] of TAG_HOSTS) if (hostIs(host, base) && (!path || path.test(u.pathname))) found.add(name)
  }
  for (const marker of facts.page.inlineMarkers) {
    const name = MARKER_NAMES[marker]
    if (name) found.add(name)
  }
  const evidence = { url, found: [...found].sort() }
  if (found.size > 0) return observation(true, false, `found: ${[...found].sort().join(', ')}`, evidence)
  return absent(raw, facts.page, 'no analytics or advertising tag found on the homepage', evidence)
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X',
}

function socialProfiles(raw: RawCapture, page: PageFacts, url: string): Observation {
  const evidence = { url, platforms: page.socialLinks }
  if (page.socialLinks.length > 0) {
    return observation(true, false, `links to ${page.socialLinks.map((p) => PLATFORM_NAMES[p] ?? p).join(', ')}`, evidence)
  }
  return absent(raw, page, 'the homepage links to no social media profile', evidence)
}

/** Site builders and CMSs, by the hosts and paths they load from. */
const PLATFORM_MARKERS: readonly (readonly [name: string, test: (host: string, urls: readonly string[]) => boolean])[] = [
  ['WordPress', (_h, urls) => urls.some((u) => u.includes('/wp-content/') || u.includes('/wp-includes/'))],
  ['Shopify', (h) => hostIs(h, 'cdn.shopify.com') || hostIs(h, 'shopifycdn.net')],
  ['Wix', (h) => hostIs(h, 'wixstatic.com') || hostIs(h, 'parastorage.com')],
  ['Squarespace', (h) => hostIs(h, 'squarespace.com') || hostIs(h, 'squarespace-cdn.com')],
  ['Webflow', (h) => hostIs(h, 'website-files.com') || hostIs(h, 'webflow.com')],
  ['GoDaddy Website Builder', (h) => hostIs(h, 'wsimg.com')],
  ['Hostinger Website Builder', (h) => hostIs(h, 'zyrosite.com') || hostIs(h, 'zyro.com')],
  ['Strikingly', (h) => hostIs(h, 'strikinglycdn.com')],
  ['Weebly', (h) => hostIs(h, 'editmysite.com')],
  ['Framer', (h) => hostIs(h, 'framerusercontent.com')],
  ['BigCommerce', (h) => hostIs(h, 'bigcommerce.com')],
  ['Blogger', (h) => hostIs(h, 'blogger.com') || hostIs(h, 'blogblog.com')],
]

/** Free builder addresses: a business on one has no domain of its own. */
const FREE_SUBDOMAINS = [
  'wixsite.com', 'business.site', 'blogspot.com', 'wordpress.com', 'weebly.com', 'godaddysites.com',
  'mystrikingly.com', 'webnode.page', 'zyrosite.com', 'myshopify.com', 'square.site', 'carrd.co', 'framer.website',
] as const

function sitePlatform(raw: RawCapture, facts: HtmlFacts, url: string): Observation {
  const hosts = loadedHosts(facts, url)
  const urls = loadedUrls(facts)
  const names = new Set<string>()
  for (const [name, test] of PLATFORM_MARKERS) {
    if (test('', urls) || hosts.some((h) => test(h, urls))) names.add(name)
  }
  const generator = facts.page.generator
  if (generator) {
    const g = generator.toLowerCase()
    for (const [needle, name] of [
      ['wordpress', 'WordPress'], ['wix', 'Wix'], ['squarespace', 'Squarespace'], ['joomla', 'Joomla'],
      ['drupal', 'Drupal'], ['webflow', 'Webflow'], ['shopify', 'Shopify'], ['ghost', 'Ghost'], ['blogger', 'Blogger'],
    ] as const) if (g.includes(needle)) names.add(name)
  }
  const landed = hostOf(url, `https://${raw.domain}/`) ?? raw.domain
  const freeSubdomain = FREE_SUBDOMAINS.find((base) => hostIs(landed, base) || hostIs(raw.domain, base)) ?? null
  const evidence = { url, platforms: [...names].sort(), generator: generator ?? 'absent', freeSubdomain }
  if (freeSubdomain) {
    return observation(true, true, `the site lives on a free ${freeSubdomain} address, not a domain of its own`, evidence)
  }
  if (names.size === 0) return notApplicable('no site builder or CMS could be identified from the homepage', evidence)
  const version = generator && /\d/.test(generator) ? ` (${pyHead(generator, 40)})` : ''
  return observation(true, false, `built with ${[...names].sort().join(', ')}${version}`, evidence)
}

function copyrightYear(raw: RawCapture, page: PageFacts, url: string): Observation {
  const capturedYear = Number(raw.capturedAt.slice(0, 4))
  const years = page.copyrightYears.filter((y) => Number.isFinite(capturedYear) && y <= capturedYear + 1)
  const latest = years.length > 0 ? Math.max(...years) : null
  const evidence = { url, years: years.slice(0, 5), latest, capturedYear }
  if (latest === null) return notApplicable('no copyright year in the page text; it may be written by a script', evidence)
  const age = capturedYear - latest
  if (age >= 2) return observation(true, true, `the footer says © ${latest}, ${age} years before this scan`, evidence)
  return observation(true, false, `the footer says © ${latest}`, evidence)
}

/** Booking, ordering and shop providers, by host. */
const BOOKING_HOSTS: readonly (readonly [name: string, host: string])[] = [
  ['Calendly', 'calendly.com'], ['Cal.com', 'cal.com'], ['Setmore', 'setmore.com'], ['SimplyBook.me', 'simplybook.me'],
  ['Acuity', 'acuityscheduling.com'], ['Booksy', 'booksy.com'], ['Fresha', 'fresha.com'], ['Vagaro', 'vagaro.com'],
  ['Zocdoc', 'zocdoc.com'], ['Practo', 'practo.com'], ['Mindbody', 'mindbodyonline.com'], ['Appointy', 'appointy.com'],
  ['Picktime', 'picktime.com'], ['OpenTable', 'opentable.com'], ['Square Appointments', 'squareup.com'],
]
const ORDERING_HOSTS: readonly (readonly [name: string, host: string])[] = [
  ['Zomato', 'zomato.com'], ['Swiggy', 'swiggy.com'], ['magicpin', 'magicpin.in'], ['Uber Eats', 'ubereats.com'],
  ['DoorDash', 'doordash.com'], ['Amazon', 'amazon.in'], ['Amazon', 'amazon.com'], ['Flipkart', 'flipkart.com'],
]
const STORE_HOSTS: readonly (readonly [name: string, host: string])[] = [
  ['Shopify', 'cdn.shopify.com'], ['Shopify', 'myshopify.com'], ['Razorpay', 'checkout.razorpay.com'],
  ['Razorpay', 'pages.razorpay.com'], ['Instamojo', 'instamojo.com'], ['Stripe', 'js.stripe.com'],
  ['Stripe', 'checkout.stripe.com'], ['PayPal', 'paypal.com'], ['Dukaan', 'mydukaan.io'],
]
const STORE_PATHS = /^\/(?:cart|checkout|shop|store|products?|order(?:-online)?|book(?:ing|-now|-online)?|appointments?|reserve|reservations?)(?:\/|$)/

function bookingOrStore(raw: RawCapture, facts: HtmlFacts, url: string): Observation {
  const hosts = [...new Set([...loadedHosts(facts, url), ...facts.page.linkHosts])]
  const pick = (table: readonly (readonly [string, string])[]): string[] =>
    [...new Set(table.filter(([, base]) => hosts.some((h) => hostIs(h, base))).map(([name]) => name))].sort()
  const booking = pick(BOOKING_HOSTS)
  const ordering = pick(ORDERING_HOSTS)
  const store = pick(STORE_HOSTS)
  if (loadedUrls(facts).some((u) => u.includes('/plugins/woocommerce/'))) store.push('WooCommerce')
  const ownPages = facts.page.ownPaths.filter((p) => STORE_PATHS.test(p)).slice(0, 5)
  const evidence = { url, booking, ordering, store: [...new Set(store)].sort(), ownPages }
  const parts = [
    booking.length ? `booking through ${booking.join(', ')}` : null,
    ordering.length ? `ordering through ${ordering.join(', ')}` : null,
    store.length ? `a store or payments (${[...new Set(store)].sort().join(', ')})` : null,
    ownPages.length ? `its own ${ownPages.join(', ')} page${ownPages.length === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null)
  if (parts.length > 0) return observation(true, false, pyHead(parts.join('; '), 160), evidence)
  const why = unread(raw, facts.page)
  if (why) return observation(false, null, why, evidence)
  // Never a gap: plenty of businesses take no bookings or orders online, and
  // the absence says nothing on its own. Read as context by whoever pitches.
  return observation(true, false, 'no online booking, ordering or store found on the homepage', evidence)
}

// ---------------------------------------------------------------------------

/** All twelve, for a homepage that answered (the caller only asks then). */
export function presenceObservations(raw: RawCapture, facts: HtmlFacts): Record<PresenceKey, Observation> {
  const url = raw.home.finalUrl || `https://${raw.domain}/`
  const page = facts.page
  return {
    mobile_viewport: mobileViewport(raw, page, url),
    page_title: pageTitle(raw, page, url),
    meta_description: metaDescription(raw, page, url),
    social_preview: socialPreview(raw, page, url),
    structured_data: structuredData(raw, page, url),
    contact_options: contactOptions(raw, page, url),
    whatsapp_chat: whatsappChat(raw, page, url),
    analytics_tags: analyticsTags(raw, facts, url),
    social_profiles: socialProfiles(raw, page, url),
    site_platform: sitePlatform(raw, facts, url),
    copyright_year: copyrightYear(raw, page, url),
    booking_or_store: bookingOrStore(raw, facts, url),
  }
}
