/**
 * What a business NEEDS, read from evidence — and which of the agency's
 * services answers it (2026-10-08).
 *
 * The agency finds businesses of every kind and offers whatever it can do
 * for them: a website where there is none, a better one, being found and
 * reviewed online, measurement, security. This turns what the CRM holds about
 * one business — its Google listing, its latest scan, its latest PageSpeed
 * audit — into a list of needs, each with the dated lines that show it, and
 * matches them to services.
 *
 * §2.2, restated for needs: a need is named only from something observed, and
 * every line says where it came from and when. What could not be established —
 * a scan past its deadline, a site never measured, a listing never read — is
 * NOT a need: it goes under `notAssessed`, so nobody pitches a business on a
 * guess. A failed scan is "did not load for our scan", never "their site is
 * down"; a failed audit is not a slow site. Pure: no clock but `now`.
 */
import { isStale } from './freshness.js'

// ---------------------------------------------------------------------------
// Websites a listing names, and placeholders for a business with none
// ---------------------------------------------------------------------------

/**
 * What the website a listing names really is. Many businesses list a
 * Facebook page, a JustDial entry or a link-in-bio page as their "website" —
 * each a different need from a site of their own.
 */
export type WebsiteKind = 'none' | 'own' | 'social' | 'link_page' | 'directory' | 'marketplace' | 'free_builder'

const KIND_HOSTS: readonly (readonly [kind: Exclude<WebsiteKind, 'none' | 'own'>, label: string, hosts: readonly string[]])[] = [
  ['social', 'a Facebook page', ['facebook.com', 'fb.com', 'fb.me']],
  ['social', 'an Instagram profile', ['instagram.com', 'instagr.am']],
  ['social', 'a LinkedIn page', ['linkedin.com']],
  ['social', 'a YouTube channel', ['youtube.com', 'youtu.be']],
  ['social', 'an X profile', ['twitter.com', 'x.com']],
  ['social', 'a social media page', ['pinterest.com', 'threads.net', 'tiktok.com']],
  ['link_page', 'a WhatsApp link', ['wa.me', 'api.whatsapp.com', 'whatsapp.com']],
  ['link_page', 'a link-in-bio page', ['linktr.ee', 'bio.link', 'beacons.ai', 'linkin.bio', 'lnk.bio', 'taplink.cc', 't.me']],
  ['directory', 'a JustDial listing', ['justdial.com']],
  ['directory', 'an IndiaMART listing', ['indiamart.com']],
  ['directory', 'a directory listing', [
    'sulekha.com', 'tradeindia.com', 'exportersindia.com', 'practo.com', 'lybrate.com', 'zomato.com', 'swiggy.com',
    'magicpin.in', 'yelp.com', 'tripadvisor.com', 'tripadvisor.in', 'urbancompany.com', 'housing.com', '99acres.com',
    'magicbricks.com', 'booking.com', 'makemytrip.com', 'goibibo.com', 'nearbuy.com', 'g.page', 'business.google.com',
    'maps.app.goo.gl',
  ]],
  ['marketplace', 'a marketplace store', ['amazon.in', 'amazon.com', 'flipkart.com', 'meesho.com', 'etsy.com', 'myntra.com', 'nykaa.com']],
  ['free_builder', 'a free website-builder address', [...[
    'wixsite.com', 'business.site', 'blogspot.com', 'wordpress.com', 'weebly.com', 'godaddysites.com', 'mystrikingly.com',
    'webnode.page', 'zyrosite.com', 'myshopify.com', 'square.site', 'carrd.co', 'framer.website', 'github.io',
  ], 'sites.google.com']],
]

/** Free builder addresses, for the scanner's `site_platform` too: one list. */
export const FREE_BUILDER_HOSTS: readonly string[] = KIND_HOSTS.filter(([kind]) => kind === 'free_builder').flatMap(([, , hosts]) => hosts)

function hostIs(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/** The host of a URL a listing names, lower-cased without `www.`; null when it is not an http(s) URL. */
export function websiteHost(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** What the website a listing names is, and the words for it. */
export function classifyWebsite(url: string | null | undefined): { readonly kind: WebsiteKind; readonly label: string; readonly host: string | null } {
  const host = websiteHost(url)
  if (!host) return { kind: 'none', label: 'no website', host: null }
  // sites.google.com is a path on google.com, so match it before the host table.
  if (host === 'sites.google.com') return { kind: 'free_builder', label: 'a free website-builder address', host }
  for (const [kind, label, hosts] of KIND_HOSTS) if (hosts.some((h) => hostIs(host, h))) return { kind, label, host }
  return { kind: 'own', label: 'a website of its own', host }
}

/**
 * A business with no website keeps a reserved placeholder in `domain`, which
 * every page and tool names a company by. `.invalid` can never resolve (RFC
 * 6761), so nothing — the scanner included — can ever reach for it.
 */
export const NO_SITE_SUFFIX = '.nosite.invalid'

export function isNoSiteDomain(domain: string): boolean {
  return domain.toLowerCase().endsWith(NO_SITE_SUFFIX)
}

/** FNV-1a, 32-bit: a short, stable tag that tells two same-named businesses apart. Not security. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The placeholder for a business with no website: its name as a slug, and a
 * tag from what identifies it (a Google place id, or its name and address),
 * so two "Sri Sai Dental" clinics in one city stay two companies.
 */
export function noSiteDomain(name: string, identity: string): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'business'
  const tag = fnv1a(`${identity}`).toString(36).padStart(6, '0').slice(-6)
  return `${slug}-${tag}${NO_SITE_SUFFIX}`
}

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------

export const NEED_KEYS = [
  'no_website', 'website_is_a_profile', 'free_builder_site', 'site_down',
  'not_mobile_friendly', 'slow_site', 'poor_accessibility', 'neglected_site',
  'weak_search_basics', 'no_link_previews', 'hard_to_contact', 'no_whatsapp', 'no_online_booking',
  'not_measuring', 'no_social_links', 'low_rating', 'few_reviews', 'security_gaps',
] as const

export type NeedKey = (typeof NEED_KEYS)[number]

export function isNeedKey(key: string): key is NeedKey {
  return (NEED_KEYS as readonly string[]).includes(key)
}

export interface NeedDefinition {
  readonly label: string
  /** What it means, for the services catalogue and the company page. */
  readonly why: string
}

export const NEEDS: Readonly<Record<NeedKey, NeedDefinition>> = Object.freeze({
  no_website: { label: 'No website', why: 'Nothing online of their own: customers find a listing and nothing to click through to.' },
  website_is_a_profile: {
    label: 'Website is only a profile or listing',
    why: 'Their listing points at a Facebook page, a directory entry or a link page instead of a site of their own.',
  },
  free_builder_site: { label: 'Site on a free builder address', why: 'The site lives on a free builder address rather than a domain of its own.' },
  site_down: { label: 'Site did not load', why: 'Their website did not answer when it was scanned — it may be down, or blocking visitors.' },
  not_mobile_friendly: { label: 'Not mobile-friendly', why: 'The homepage is not laid out for phones, where most visits happen.' },
  slow_site: { label: 'Slow on phones', why: 'Google’s PageSpeed measured the homepage as slow on a phone.' },
  poor_accessibility: { label: 'Hard to use for some visitors', why: 'PageSpeed’s accessibility check scored the homepage low.' },
  neglected_site: { label: 'Site looks neglected', why: 'Signs nobody has touched the site in years, such as an old footer year.' },
  weak_search_basics: { label: 'Weak search basics', why: 'Missing or generic titles, descriptions or structured data, so search shows them poorly.' },
  no_link_previews: { label: 'No link previews', why: 'A link to the site shared on WhatsApp or social media shows no preview card.' },
  hard_to_contact: { label: 'Hard to contact', why: 'No tap-to-call, email, WhatsApp link or form on the homepage.' },
  no_whatsapp: { label: 'No WhatsApp chat', why: 'No WhatsApp chat link, which many customers prefer to a call.' },
  no_online_booking: { label: 'No online booking or ordering', why: 'A business customers book or order from, with no way to do it online.' },
  not_measuring: { label: 'Not measuring visits', why: 'No analytics or advertising tag, so visits and campaigns are not measured.' },
  no_social_links: { label: 'No social media links', why: 'The site links to no social media profile.' },
  low_rating: { label: 'Low Google rating', why: 'Their Google rating is below 4.0, which costs them customers who compare.' },
  few_reviews: { label: 'Few Google reviews', why: 'Fewer than 25 Google reviews, so they look small next to competitors.' },
  security_gaps: { label: 'Website security gaps', why: 'Gaps a review of the website from the outside found, such as missing protections.' },
})

/** The security signals the scanner scores — the ones a `security_gaps` need is read from. */
export const SECURITY_SIGNAL_KEYS: readonly string[] = [
  'csp', 'hsts', 'frame_protection', 'content_type_options', 'referrer_policy', 'permissions_policy',
  'tls', 'security_txt', 'trust_page', 'outdated_js', 'server_banner', 'compliance_claim',
]

/** Google place types whose customers book or order — where no online booking is a need. */
const BOOKS_OR_ORDERS = /^(dentist|dental_clinic|doctor|medical_clinic|hospital|physiotherapist|chiropractor|veterinary_care|beauty_salon|hair_salon|hair_care|barber_shop|nail_salon|spa|massage|gym|fitness_center|yoga_studio|restaurant|cafe|bakery|meal_delivery|meal_takeaway|lodging|hotel|guest_house|car_repair|car_wash|tutoring|school|driving_school|lawyer|accounting|real_estate_agency|event_venue|wedding_venue|photographer|florist)$/

/** A listing older than this is re-read before anyone quotes it. */
export const LISTING_STALE_DAYS = 90

export interface OpportunityFinding {
  readonly key: string
  readonly observed: boolean
  readonly gap: boolean | null
  readonly detail: string | null
  readonly evidence?: unknown
}

export interface OpportunityFacts {
  /** `companies.domain` — a placeholder (`isNoSiteDomain`) for a business with no website. */
  readonly domain: string
  readonly listing: null | {
    readonly checkedAt: Date
    /** The website the LISTING names, as given. */
    readonly website: string | null
    readonly rating: number | null
    readonly reviews: number | null
    /** The listing's primary type, e.g. `dentist`. */
    readonly category: string | null
  }
  /** The latest scan, ok or not, with its findings. */
  readonly scan: null | {
    readonly ranAt: Date
    readonly ok: boolean
    readonly findings: readonly OpportunityFinding[]
  }
  /** The latest PageSpeed audit. */
  readonly audit: null | {
    readonly ranAt: Date
    readonly ok: boolean
    readonly strategy: string
    readonly error: string | null
    readonly performance: number | null
    readonly seo: number | null
    readonly accessibility: number | null
    readonly lcpMs: number | null
  }
  /** The active profile's `staleAfterDaysOf` — scans and audits age by it. */
  readonly staleAfterDays: number
}

export type NeedSource = 'listing' | 'scan' | 'audit'

export interface Need {
  readonly key: NeedKey
  readonly label: string
  /** The dated lines that show it — quotable while their source is current. */
  readonly evidence: readonly string[]
  readonly source: NeedSource
  /** When the evidence was observed. */
  readonly asOf: Date
}

export interface NeedsReading {
  readonly needs: readonly Need[]
  /** What could not be established, and what would establish it. Never a need. */
  readonly notAssessed: readonly string[]
  /** The website on record: a domain of their own, or what the listing names. */
  readonly website: { readonly kind: WebsiteKind; readonly label: string; readonly host: string | null }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Which need a website-presence gap shows. */
const PRESENCE_NEEDS: Readonly<Record<string, NeedKey>> = {
  mobile_viewport: 'not_mobile_friendly',
  page_title: 'weak_search_basics',
  meta_description: 'weak_search_basics',
  structured_data: 'weak_search_basics',
  social_preview: 'no_link_previews',
  contact_options: 'hard_to_contact',
  whatsapp_chat: 'no_whatsapp',
  analytics_tags: 'not_measuring',
  social_profiles: 'no_social_links',
  copyright_year: 'neglected_site',
  site_platform: 'free_builder_site',
}

/**
 * The needs one business shows, from what is on record. See the module note:
 * only observed, current evidence names a need; everything else is listed as
 * not assessed, with what would assess it.
 */
export function needsOf(facts: OpportunityFacts, now: Date): NeedsReading {
  const found = new Map<NeedKey, { evidence: string[]; source: NeedSource; asOf: Date }>()
  const add = (key: NeedKey, line: string, source: NeedSource, asOf: Date): void => {
    const had = found.get(key)
    if (had) {
      if (had.evidence.length < 4 && !had.evidence.includes(line)) had.evidence.push(line)
    } else {
      found.set(key, { evidence: [line], source, asOf })
    }
  }
  const notAssessed: string[] = []
  const noSite = isNoSiteDomain(facts.domain)
  const listing = facts.listing
  const listingFresh = listing !== null && !isStale(listing.checkedAt, LISTING_STALE_DAYS, now)

  // The website: theirs, or what their listing names.
  let website: NeedsReading['website'] = noSite
    ? classifyWebsite(listing?.website ?? null)
    : { kind: 'own', label: 'a website of its own', host: facts.domain }

  if (listing && !listingFresh) {
    notAssessed.push(`The Google listing was read on ${day(listing.checkedAt)}, more than ${LISTING_STALE_DAYS} days ago — read it again before quoting it.`)
  }
  if (noSite) {
    if (!listing) {
      notAssessed.push('No website is on record for them, and no listing was read — whether they have a website was not established.')
      website = { kind: 'none', label: 'no website on record', host: null }
    } else if (listingFresh) {
      const read = day(listing.checkedAt)
      if (website.kind === 'none') add('no_website', `Google Maps lists no website for them (read ${read}).`, 'listing', listing.checkedAt)
      else if (website.kind === 'free_builder') {
        add('free_builder_site', `Their Google listing's website is ${website.label} (${website.host}, read ${read}).`, 'listing', listing.checkedAt)
      } else if (website.kind !== 'own') {
        add('website_is_a_profile', `Their Google listing's website is ${website.label} (${website.host}, read ${read}).`, 'listing', listing.checkedAt)
      }
    }
  }

  if (listing && listingFresh) {
    const read = day(listing.checkedAt)
    if (listing.rating !== null && listing.reviews !== null && listing.reviews >= 5 && listing.rating < 4) {
      add('low_rating', `Rated ${listing.rating.toFixed(1)} from ${listing.reviews} reviews on Google Maps (read ${read}).`, 'listing', listing.checkedAt)
    }
    if (listing.reviews !== null && listing.reviews < 25) {
      add('few_reviews', `${listing.reviews === 0 ? 'No' : `Only ${listing.reviews}`} Google review${listing.reviews === 1 ? '' : 's'} (read ${read}).`, 'listing', listing.checkedAt)
    }
  }

  // The latest scan of their own site.
  const scan = facts.scan
  if (!noSite) {
    if (!scan) {
      notAssessed.push('Their website has never been scanned — scan it before saying anything about it.')
    } else if (isStale(scan.ranAt, facts.staleAfterDays, now)) {
      notAssessed.push(`The latest scan (${day(scan.ranAt)}) is past its re-verification deadline — scan again before quoting the website's state.`)
    } else if (!scan.ok) {
      add('site_down', `The website did not load for our scan on ${day(scan.ranAt)}.`, 'scan', scan.ranAt)
    } else {
      const on = day(scan.ranAt)
      const security: string[] = []
      for (const f of scan.findings) {
        if (!f.observed || f.gap !== true) continue
        const need = PRESENCE_NEEDS[f.key]
        if (need) add(need, `${capitalised(f.detail ?? f.key)} (scan of ${on}).`, 'scan', scan.ranAt)
        else if (SECURITY_SIGNAL_KEYS.includes(f.key)) security.push(f.detail ?? f.key)
      }
      if (security.length > 0) {
        add('security_gaps', `${security.length} website security gap${security.length === 1 ? '' : 's'} in the scan of ${on}, e.g. ${security.slice(0, 2).join('; ')}.`, 'scan', scan.ranAt)
      }
      // No booking is a need only for a business customers book or order from.
      const booking = scan.findings.find((f) => f.key === 'booking_or_store' && f.observed)
      const category = listing?.category ?? null
      if (booking && category && BOOKS_OR_ORDERS.test(category) && /^no online booking/.test(booking.detail ?? '')) {
        add('no_online_booking', `A ${category.replace(/_/g, ' ')} with no online booking, ordering or store on its homepage (scan of ${on}).`, 'scan', scan.ranAt)
      }
    }
  }

  // The latest PageSpeed audit.
  const audit = facts.audit
  if (!noSite) {
    if (!audit) {
      notAssessed.push('Speed has not been measured — audit the site with PageSpeed before saying it is slow or fast.')
    } else if (isStale(audit.ranAt, facts.staleAfterDays, now)) {
      notAssessed.push(`The latest PageSpeed audit (${day(audit.ranAt)}) is past its re-verification deadline — audit it again before quoting it.`)
    } else if (!audit.ok) {
      notAssessed.push(`PageSpeed could not measure the site on ${day(audit.ranAt)}${audit.error ? ` (${audit.error})` : ''} — that is not a slow site.`)
    } else {
      const on = day(audit.ranAt)
      const device = audit.strategy === 'desktop' ? 'desktop' : 'mobile'
      if (audit.performance !== null && audit.performance < 50) {
        const lcp = audit.lcpMs !== null ? `, main content shown after ${(audit.lcpMs / 1000).toFixed(1)} s` : ''
        add('slow_site', `Google PageSpeed scored the ${device} homepage ${audit.performance}/100 for performance${lcp} (${on}).`, 'audit', audit.ranAt)
      }
      if (audit.seo !== null && audit.seo < 80) {
        add('weak_search_basics', `PageSpeed's SEO check scored the ${device} homepage ${audit.seo}/100 (${on}).`, 'audit', audit.ranAt)
      }
      if (audit.accessibility !== null && audit.accessibility < 70) {
        add('poor_accessibility', `PageSpeed's accessibility check scored the ${device} homepage ${audit.accessibility}/100 (${on}).`, 'audit', audit.ranAt)
      }
    }
  }

  const needs = NEED_KEYS.filter((k) => found.has(k)).map((key): Need => {
    const f = found.get(key)!
    return { key, label: NEEDS[key].label, evidence: f.evidence, source: f.source, asOf: f.asOf }
  })
  return { needs, notAssessed, website }
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface ServiceLike {
  readonly name: string
  readonly needs: readonly string[]
}

/**
 * The services that answer at least one of these needs, those answering the
 * most first, then by name. A service that names no need is never matched —
 * it is offered by hand.
 */
export function servicesFor<S extends ServiceLike>(
  needs: readonly Pick<Need, 'key'>[],
  services: readonly S[],
): { readonly service: S; readonly answers: readonly NeedKey[] }[] {
  const have = new Set(needs.map((n) => n.key))
  return services
    .map((service) => ({ service, answers: NEED_KEYS.filter((k) => have.has(k) && service.needs.includes(k)) }))
    .filter((m) => m.answers.length > 0)
    .sort((a, b) => b.answers.length - a.answers.length || a.service.name.localeCompare(b.service.name))
}

/**
 * A starting catalogue for an agency that has written none, offered on
 * Settings → Services and used — and labelled as suggestions — until one
 * exists. No prices: those are the agency's.
 */
export const SUGGESTED_SERVICES: readonly { readonly name: string; readonly description: string; readonly needs: readonly NeedKey[] }[] = [
  {
    name: 'New website',
    description: 'A fast, mobile-ready website on their own domain, with tap-to-call, WhatsApp and map buttons.',
    needs: ['no_website', 'website_is_a_profile', 'free_builder_site', 'site_down'],
  },
  {
    name: 'Website redesign',
    description: 'Rebuild or refresh an existing site: mobile layout, speed, clear ways to get in touch, an up-to-date look.',
    needs: ['not_mobile_friendly', 'neglected_site', 'slow_site', 'hard_to_contact', 'poor_accessibility', 'free_builder_site'],
  },
  { name: 'Speed optimisation', description: 'Make the existing site load fast on phones.', needs: ['slow_site'] },
  {
    name: 'Search engine optimisation',
    description: 'Titles, descriptions, structured data and content so the business is found in search.',
    needs: ['weak_search_basics', 'no_link_previews'],
  },
  {
    name: 'WhatsApp and lead capture',
    description: 'WhatsApp chat, tap-to-call and enquiry forms that turn visits into conversations.',
    needs: ['no_whatsapp', 'hard_to_contact'],
  },
  { name: 'Online booking or ordering', description: 'Let customers book, order or pay online.', needs: ['no_online_booking'] },
  {
    name: 'Google Business Profile and reviews',
    description: 'Complete and optimise the Maps listing, and grow and answer reviews.',
    needs: ['low_rating', 'few_reviews', 'no_website'],
  },
  {
    name: 'Social media management',
    description: 'Set up and run Instagram, Facebook and LinkedIn, linked from the site.',
    needs: ['no_social_links', 'no_link_previews'],
  },
  { name: 'Analytics and ads setup', description: 'Measure visits and run ads that can be tracked.', needs: ['not_measuring'] },
  { name: 'Security hardening', description: 'Fix the website security gaps a review from the outside finds.', needs: ['security_gaps'] },
]
