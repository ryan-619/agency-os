/**
 * What a business needs, from evidence (2026-10-08). §2.2 restated: a need is
 * named only from something observed and current, every line is dated, and
 * what could not be established is listed as not assessed — never a need.
 */
import { describe, expect, it } from 'vitest'
import {
  FREE_BUILDER_HOSTS, NEED_KEYS, NEEDS, SUGGESTED_SERVICES, classifyWebsite, isNeedKey, isNoSiteDomain, needsOf,
  noSiteDomain, servicesFor, type OpportunityFacts, type OpportunityFinding,
} from '../src/index.js'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const DAYS = 86_400_000

function facts(over: Partial<OpportunityFacts> = {}): OpportunityFacts {
  return { domain: 'kumardental.in', listing: null, scan: null, audit: null, staleAfterDays: 14, ...over }
}

function gap(key: string, detail: string): OpportunityFinding {
  return { key, observed: true, gap: true, detail }
}

const keys = (r: ReturnType<typeof needsOf>) => r.needs.map((n) => n.key)

describe('classifyWebsite', () => {
  it('tells a site of their own from a profile, a listing, a link page and a free builder', () => {
    expect(classifyWebsite('https://www.facebook.com/kumardental')).toMatchObject({ kind: 'social', label: 'a Facebook page' })
    expect(classifyWebsite('http://www.justdial.com/Bangalore/Kumar')).toMatchObject({ kind: 'directory', label: 'a JustDial listing' })
    expect(classifyWebsite('linktr.ee/kumar')).toMatchObject({ kind: 'link_page' })
    expect(classifyWebsite('https://wa.me/919876543210')).toMatchObject({ kind: 'link_page', label: 'a WhatsApp link' })
    expect(classifyWebsite('https://kumar.wixsite.com/clinic')).toMatchObject({ kind: 'free_builder' })
    expect(classifyWebsite('https://sites.google.com/view/kumar')).toMatchObject({ kind: 'free_builder' })
    expect(classifyWebsite('https://www.amazon.in/stores/kumar')).toMatchObject({ kind: 'marketplace' })
    expect(classifyWebsite('https://kumardental.in/')).toMatchObject({ kind: 'own', host: 'kumardental.in' })
    expect(classifyWebsite(null)).toMatchObject({ kind: 'none' })
    expect(classifyWebsite('')).toMatchObject({ kind: 'none' })
  })

  it('shares one free-builder list with the scanner', () => {
    expect(FREE_BUILDER_HOSTS).toContain('wixsite.com')
    expect(FREE_BUILDER_HOSTS).toContain('business.site')
  })
})

describe('a business with no website', () => {
  it('gets a placeholder that can never resolve, stable and distinct per identity', () => {
    const a = noSiteDomain('Sri Sai Dental Clinic', 'place:ChIJ1')
    expect(a).toMatch(/^sri-sai-dental-clinic-[0-9a-z]{6}\.nosite\.invalid$/)
    expect(noSiteDomain('Sri Sai Dental Clinic', 'place:ChIJ1')).toBe(a)
    expect(noSiteDomain('Sri Sai Dental Clinic', 'place:ChIJ2')).not.toBe(a)
    expect(isNoSiteDomain(a)).toBe(true)
    expect(isNoSiteDomain('kumardental.in')).toBe(false)
    expect(noSiteDomain('ಕನ್ನಡ', 'x')).toMatch(/^business-[0-9a-z]{6}\.nosite\.invalid$/)
  })

  it('needs a website when its fresh listing names none, dated by the listing', () => {
    const r = needsOf(
      facts({
        domain: noSiteDomain('Kumar Dental', 'p1'),
        listing: { checkedAt: new Date(NOW.getTime() - 2 * DAYS), website: null, rating: 4.6, reviews: 12, category: 'dentist' },
      }),
      NOW,
    )
    expect(keys(r)).toEqual(['no_website', 'few_reviews'])
    expect(r.needs[0]!.evidence).toEqual(['Google Maps lists no website for them (read 2026-10-06).'])
    expect(r.needs[1]!.evidence).toEqual(['Only 12 Google reviews (read 2026-10-06).'])
    // Nothing about a site nobody has: no scan, no audit asked for.
    expect(r.notAssessed).toEqual([])
  })

  it('reads a listing whose website is a Facebook page as a profile, not a site', () => {
    const r = needsOf(
      facts({
        domain: noSiteDomain('Kumar Dental', 'p1'),
        listing: { checkedAt: NOW, website: 'https://facebook.com/kumar', rating: 3.4, reviews: 40, category: null },
      }),
      NOW,
    )
    expect(keys(r)).toEqual(['website_is_a_profile', 'low_rating'])
    expect(r.needs[0]!.evidence[0]).toMatch(/a Facebook page \(facebook\.com/)
    expect(r.needs[1]!.evidence[0]).toBe('Rated 3.4 from 40 reviews on Google Maps (read 2026-10-08).')
  })

  it('claims nothing when no listing was read, and nothing from a listing gone stale', () => {
    const none = needsOf(facts({ domain: noSiteDomain('Kumar', 'x') }), NOW)
    expect(none.needs).toEqual([])
    expect(none.notAssessed[0]).toMatch(/whether they have a website was not established/)
    const old = needsOf(
      facts({
        domain: noSiteDomain('Kumar', 'x'),
        listing: { checkedAt: new Date(NOW.getTime() - 120 * DAYS), website: null, rating: 2, reviews: 3, category: null },
      }),
      NOW,
    )
    expect(old.needs).toEqual([])
    expect(old.notAssessed[0]).toMatch(/read it again before quoting it/)
  })
})

describe('a business with a website', () => {
  const fresh = new Date(NOW.getTime() - 3 * DAYS)

  it('says the site was never scanned or measured, rather than guessing', () => {
    const r = needsOf(facts(), NOW)
    expect(r.needs).toEqual([])
    expect(r.notAssessed).toEqual([
      expect.stringMatching(/never been scanned/),
      expect.stringMatching(/Speed has not been measured/),
    ])
  })

  it('reads presence gaps from a fresh scan as needs, dated by the scan, and ignores what was not observed', () => {
    const r = needsOf(
      facts({
        scan: {
          ranAt: fresh,
          ok: true,
          findings: [
            gap('mobile_viewport', "no viewport tag: phones show the desktop layout, zoomed out"),
            gap('meta_description', 'no meta description: search results show whatever text the search engine picks'),
            gap('whatsapp_chat', 'no WhatsApp chat link on the homepage'),
            gap('copyright_year', 'the footer says © 2019, 7 years before this scan'),
            gap('csp', 'header absent on homepage response'),
            gap('hsts', 'header absent on homepage response'),
            { key: 'analytics_tags', observed: false, gap: null, detail: 'not assessed — the homepage could not be read to its end' },
          ],
        },
      }),
      NOW,
    )
    expect(keys(r)).toEqual(['not_mobile_friendly', 'neglected_site', 'weak_search_basics', 'no_whatsapp', 'security_gaps'])
    expect(r.needs[0]!.evidence[0]).toBe("No viewport tag: phones show the desktop layout, zoomed out (scan of 2026-10-05).")
    expect(r.needs.at(-1)!.evidence[0]).toMatch(/^2 website security gaps in the scan of 2026-10-05/)
    expect(keys(r)).not.toContain('not_measuring')
  })

  it('names no need from a stale scan, and calls a failed scan a load failure, not a dead site', () => {
    const stale = needsOf(facts({ scan: { ranAt: new Date(NOW.getTime() - 30 * DAYS), ok: true, findings: [gap('mobile_viewport', 'x')] } }), NOW)
    expect(stale.needs).toEqual([])
    expect(stale.notAssessed[0]).toMatch(/past its re-verification deadline/)
    const failed = needsOf(facts({ scan: { ranAt: fresh, ok: false, findings: [] } }), NOW)
    expect(failed.needs.map((n) => n.evidence[0])).toEqual(['The website did not load for our scan on 2026-10-05.'])
  })

  it('needs online booking only for a business customers book from', () => {
    const scan = {
      ranAt: fresh,
      ok: true,
      findings: [{ key: 'booking_or_store', observed: true, gap: false, detail: 'no online booking, ordering or store found on the homepage' }],
    }
    const listing = (category: string) => ({ checkedAt: NOW, website: 'https://kumardental.in', rating: 4.8, reviews: 200, category })
    expect(keys(needsOf(facts({ scan, listing: listing('dentist') }), NOW))).toContain('no_online_booking')
    expect(keys(needsOf(facts({ scan, listing: listing('manufacturer') }), NOW))).not.toContain('no_online_booking')
  })

  it('reads a slow, low-SEO audit as needs, and a failed one as not assessed', () => {
    const audit = { ranAt: fresh, ok: true, strategy: 'mobile', error: null, performance: 31, seo: 72, accessibility: 95, lcpMs: 6100 }
    const r = needsOf(facts({ audit }), NOW)
    expect(keys(r)).toEqual(['slow_site', 'weak_search_basics'])
    expect(r.needs[0]!.evidence[0]).toBe(
      'Google PageSpeed scored the mobile homepage 31/100 for performance, main content shown after 6.1 s (2026-10-05).',
    )
    const failed = needsOf(facts({ audit: { ...audit, ok: false, error: 'the page did not load', performance: null, seo: null } }), NOW)
    expect(failed.needs).toEqual([])
    expect(failed.notAssessed.join(' ')).toMatch(/that is not a slow site/)
  })
})

describe('services', () => {
  it('matches services by the needs they answer, most first', () => {
    const needs = [{ key: 'no_whatsapp' as const }, { key: 'hard_to_contact' as const }, { key: 'slow_site' as const }]
    const matched = servicesFor(needs, SUGGESTED_SERVICES)
    // Two services answer two of the needs each; a tie is broken by name.
    expect(matched.slice(0, 2)).toMatchObject([
      { service: { name: 'Website redesign' }, answers: ['slow_site', 'hard_to_contact'] },
      { service: { name: 'WhatsApp and lead capture' }, answers: ['hard_to_contact', 'no_whatsapp'] },
    ])
    expect(matched.map((m) => m.service.name)).toContain('Speed optimisation')
    expect(servicesFor(needs, [{ name: 'Video production', needs: [] }])).toEqual([])
  })

  it('suggests only needs that exist, and words every need', () => {
    for (const s of SUGGESTED_SERVICES) for (const n of s.needs) expect(isNeedKey(n), `${s.name}: ${n}`).toBe(true)
    for (const key of NEED_KEYS) {
      expect(NEEDS[key].label.length, key).toBeGreaterThan(3)
      expect(NEEDS[key].why.length, key).toBeGreaterThan(20)
    }
  })
})
