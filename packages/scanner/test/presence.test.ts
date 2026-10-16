/**
 * The twelve website-presence signals (presence.ts, 2026-10-08), on
 * hand-built captures.
 *
 * What is worth asserting is §2.2 restated for websites: an absence is a
 * reading only off a page read to its end, a contact link is counted and never
 * kept, "not applicable" claims nothing, and nothing reads a clock.
 */
import { describe, it, expect } from 'vitest'
import { PRESENCE_SIGNAL_KEYS, presenceObservations, type PresenceKey } from '../src/presence.js'
import { extractHtmlFacts } from '../src/html.js'
import type { RawCapture } from '../src/types.js'

type Home = RawCapture['home']

function capture(home: Partial<Home> = {}): RawCapture {
  return {
    domain: 'kumardental.in',
    capturedAt: '2026-09-10T00:00:00.000Z',
    home: { ok: true, status: 200, finalUrl: 'https://kumardental.in/', headers: {}, body: page(''), ...home },
    paths: {},
    tls: { ok: true, protocol: 'TLSv1.3', issuer: "Let's Encrypt", expires: '2026-12-01', daysToExpiry: 82 },
  }
}

/** A whole page: the walk reaches </body>. */
function page(body: string, head = '<title>Kumar Dental Clinic, Indiranagar</title>'): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
}

function one(key: PresenceKey, home: Partial<Home> = {}) {
  const raw = capture(home)
  return presenceObservations(raw, extractHtmlFacts(raw.home.body))[key]
}

describe('the presence key set', () => {
  it('is twelve keys', () => {
    expect(PRESENCE_SIGNAL_KEYS).toHaveLength(12)
    expect(new Set(PRESENCE_SIGNAL_KEYS).size).toBe(12)
  })
})

describe('an absence is a reading only off a whole page', () => {
  const absences: PresenceKey[] = [
    'mobile_viewport', 'meta_description', 'social_preview', 'structured_data', 'contact_options',
    'whatsapp_chat', 'analytics_tags', 'social_profiles',
  ]

  it('calls each absence a gap on a page read to its end', () => {
    for (const key of absences) expect(one(key), key).toMatchObject({ observed: true, gap: true })
  })

  it('leaves each one unobserved when the walk never reached </body>', () => {
    const cut = '<html><head><title>Kumar Dental</title></head><body><p>Welcome'
    for (const key of absences) {
      expect(one(key, { body: cut }), key).toMatchObject({ observed: false, gap: null, detail: expect.stringMatching(/not assessed/) })
    }
  })

  it('leaves each one unobserved when the body was cut at the read cap', () => {
    for (const key of absences) {
      expect(one(key, { truncated: true }), key).toMatchObject({ observed: false, gap: null })
    }
  })

  it('leaves each one unobserved when the page ends inside an unclosed <script>', () => {
    const unclosed = '<html><head><title>Kumar</title><script>var x = 1;</head><body></body></html>'
    expect(one('mobile_viewport', { body: unclosed })).toMatchObject({ observed: false })
  })
})

describe('mobile_viewport', () => {
  it('is set for phones with width=device-width, or initial-scale=1', () => {
    const head = '<title>Kumar</title><meta name="viewport" content="width=device-width, initial-scale=1">'
    expect(one('mobile_viewport', { body: page('', head) })).toMatchObject({ observed: true, gap: false })
    expect(one('mobile_viewport', { body: page('', '<title>Kumar</title><meta name="viewport" content="initial-scale=1.0">') }))
      .toMatchObject({ gap: false })
  })

  it('is a gap when the viewport is fixed to a desktop width', () => {
    const head = '<title>Kumar</title><meta name="viewport" content="width=1024">'
    expect(one('mobile_viewport', { body: page('', head) })).toMatchObject({
      observed: true, gap: true, detail: expect.stringMatching(/width=1024/),
    })
  })
})

describe('page_title', () => {
  it('reads the real title, not an SVG icon’s', () => {
    const body = page('<svg><title>icon</title></svg>', '<title>Kumar Dental Clinic</title>')
    expect(one('page_title', { body })).toMatchObject({ gap: false, detail: '"Kumar Dental Clinic"' })
    const svgOnly = page('<svg><title>menu icon</title></svg>', '')
    expect(one('page_title', { body: svgOnly })).toMatchObject({ observed: true, gap: true, detail: expect.stringMatching(/no page title/) })
  })

  it('is a gap for a generic or unfinished title', () => {
    expect(one('page_title', { body: page('', '<title>Home</title>') })).toMatchObject({ gap: true, detail: expect.stringMatching(/just "Home"/) })
    expect(one('page_title', { body: page('', '<title>Coming Soon!</title>') })).toMatchObject({
      gap: true, detail: expect.stringMatching(/may not be finished/),
    })
    expect(one('page_title', { body: page('', '<title> </title>') })).toMatchObject({ gap: true, detail: 'the page title is empty' })
  })
})

describe('meta_description and social_preview', () => {
  it('reads a description by its length', () => {
    const head = '<title>Kumar</title><meta name="description" content="Family dentist in Indiranagar, Bengaluru, open six days a week.">'
    expect(one('meta_description', { body: page('', head) })).toMatchObject({ gap: false, evidence: { length: 63 } })
    expect(one('meta_description', { body: page('', '<title>Kumar</title><meta name="description" content="">') }))
      .toMatchObject({ gap: true })
  })

  it('needs a preview image, not only a title', () => {
    const titled = '<title>Kumar</title><meta property="og:title" content="Kumar Dental">'
    expect(one('social_preview', { body: page('', titled) })).toMatchObject({ gap: true, detail: expect.stringMatching(/no picture/) })
    const pictured = `${titled}<meta property="og:image" content="https://kumardental.in/og.jpg">`
    expect(one('social_preview', { body: page('', pictured) })).toMatchObject({ gap: false })
  })
})

describe('structured_data', () => {
  it('names the schema.org types it finds, in JSON-LD or microdata', () => {
    const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Kumar"}</script>'
    expect(one('structured_data', { body: page(ld) })).toMatchObject({ gap: false, detail: expect.stringMatching(/Dentist/) })
    const graph = '<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["LocalBusiness"]}]}</script>'
    expect(one('structured_data', { body: page(graph) }).evidence).toMatchObject({ types: ['Organization', 'LocalBusiness'] })
    const micro = '<div itemscope itemtype="https://schema.org/Restaurant"></div>'
    expect(one('structured_data', { body: page(micro) })).toMatchObject({ gap: false, detail: expect.stringMatching(/Restaurant/) })
  })

  it('counts a block it cannot parse as a block, with no types', () => {
    const broken = '<script type="application/ld+json">{not json</script>'
    expect(one('structured_data', { body: page(broken) })).toMatchObject({ gap: false, evidence: { blocks: 1, types: [] } })
  })
})

describe('contact_options and whatsapp_chat', () => {
  const body = page(
    '<a href="tel:+919876543210">Call</a> <a href="mailto:dr.kumar@kumardental.in">Mail</a> ' +
      '<a href="https://wa.me/919876543210?text=Hi">WhatsApp</a><form action="/enquiry"></form>',
  )

  it('counts the ways in, and never keeps a number or an address', () => {
    const o = one('contact_options', { body })
    expect(o).toMatchObject({ gap: false, evidence: { phoneLinks: 1, emailLinks: 1, whatsappLinks: 1, forms: 1 } })
    expect(o.detail).toMatch(/tap-to-call link, an email link, a WhatsApp link, a form/)
    const all = JSON.stringify(presenceObservations(capture({ body }), extractHtmlFacts(body)))
    expect(all).not.toContain('9876543210')
    expect(all).not.toContain('dr.kumar@')
  })

  it('finds a WhatsApp link on wa.me or api.whatsapp.com', () => {
    expect(one('whatsapp_chat', { body })).toMatchObject({ gap: false })
    expect(one('whatsapp_chat', { body: page('<a href="https://api.whatsapp.com/send?phone=91">Chat</a>') })).toMatchObject({ gap: false })
    expect(one('whatsapp_chat', { body: page('<a href="tel:+911234567">Call</a>') })).toMatchObject({ gap: true })
  })
})

describe('analytics_tags', () => {
  it('finds tags by their script, their noscript fallback, or an inline snippet', () => {
    expect(one('analytics_tags', { body: page('<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>') }))
      .toMatchObject({ gap: false, evidence: { found: ['Google Analytics'] } })
    const gtm = "<script>(function(w,d){var j=d.createElement('script');j.src='https://www.googletagmanager.com/gtm.js?id=GTM-1';})(window,document)</script>"
    expect(one('analytics_tags', { body: page(gtm) })).toMatchObject({ evidence: { found: ['Google Tag Manager'] } })
    const pixel = '<noscript><img height="1" src="https://www.facebook.com/tr?id=1&ev=PageView"></noscript>'
    expect(one('analytics_tags', { body: page(pixel) })).toMatchObject({ evidence: { found: ['Meta pixel'] } })
  })
})

describe('social_profiles', () => {
  it('lists the platforms linked to', () => {
    const body = page('<a href="https://instagram.com/kumardental">IG</a><a href="https://www.facebook.com/kumar">FB</a>')
    expect(one('social_profiles', { body })).toMatchObject({ gap: false, evidence: { platforms: ['facebook', 'instagram'] } })
  })
})

describe('site_platform', () => {
  it('identifies the builder, and never calls one a gap', () => {
    expect(one('site_platform', { body: page('<script src="/wp-content/themes/x/app.js"></script>') })).toMatchObject({
      gap: false, detail: expect.stringMatching(/WordPress/),
    })
    expect(one('site_platform', { body: page('', '<title>Kumar</title><meta name="generator" content="Wix.com Website Builder">') }))
      .toMatchObject({ gap: false, detail: expect.stringMatching(/Wix/) })
  })

  it('is a gap when the site lives on a free builder address', () => {
    const o = one('site_platform', { finalUrl: 'https://kumardental.wixsite.com/home' })
    expect(o).toMatchObject({ gap: true, evidence: { freeSubdomain: 'wixsite.com' } })
  })

  it('is not applicable when nothing can be identified', () => {
    expect(one('site_platform').detail).toMatch(/^not applicable/)
  })
})

describe('copyright_year', () => {
  it('reads the latest year against the capture’s own date, never the clock', () => {
    expect(one('copyright_year', { body: page('<footer>© 2019 Kumar Dental</footer>') })).toMatchObject({
      gap: true, detail: 'the footer says © 2019, 7 years before this scan',
    })
    expect(one('copyright_year', { body: page('<footer>Copyright 2015 – 2026 Kumar</footer>') })).toMatchObject({ gap: false })
    expect(one('copyright_year', { body: page('<footer>&copy; 2025</footer>') })).toMatchObject({ gap: false })
  })

  it('is not applicable when no year is in the text', () => {
    expect(one('copyright_year', { body: page('<footer>© <span id="y"></span></footer>') }).detail).toMatch(/^not applicable/)
  })
})

describe('booking_or_store', () => {
  it('names booking, ordering and store providers, and its own order pages', () => {
    const body = page(
      '<a href="https://calendly.com/kumar">Book</a><a href="https://www.zomato.com/x">Order</a>' +
        '<script src="https://checkout.razorpay.com/v1/checkout.js"></script><a href="/book-online">Book</a>',
    )
    const o = one('booking_or_store', { body })
    expect(o).toMatchObject({ gap: false, evidence: { booking: ['Calendly'], ordering: ['Zomato'], store: ['Razorpay'], ownPages: ['/book-online'] } })
  })

  it('is never a gap, and unobserved off half a page', () => {
    expect(one('booking_or_store')).toMatchObject({ observed: true, gap: false, detail: expect.stringMatching(/no online booking/) })
    expect(one('booking_or_store', { body: '<html><body><p>cut' })).toMatchObject({ observed: false })
  })
})
