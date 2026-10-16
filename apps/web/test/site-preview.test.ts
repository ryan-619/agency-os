/**
 * The website preview's page (2026-10-08), rendered for real: the banner
 * that says whose preview it is, every fact from the listing and nothing it
 * does not hold, and its kind of business's template.
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SitePreview, type SitePreviewBusiness } from '../src/components/share/site-preview'

// The suite compiles JSX with the classic runtime, as proposal-buyer-view.test.ts says: the
// component calls `React.createElement` on a global at render time.
;(globalThis as { React?: typeof React }).React = React

const kumar: SitePreviewBusiness = {
  name: 'Kumar Dental Clinic', category: 'dentist', city: 'Bengaluru', phone: '+918041234567',
  address: '12 CMH Road, Indiranagar, Bengaluru', mapsUrl: 'https://maps.google.com/?cid=1', rating: 4.6, reviews: 1234,
  listingCheckedAt: new Date('2026-10-07T10:00:00Z'),
}
const render = (business: SitePreviewBusiness, talk: string | null = 'https://wa.me/919876543210') =>
  renderToStaticMarkup(React.createElement(SitePreview, { business, agency: 'Accemy', talkToAgency: talk, year: 2026 }))

describe('the website preview', () => {
  it('says whose preview it is and that it is not a live website, before anything else', () => {
    const html = render(kumar)
    const banner = html.indexOf('A preview made by <strong>Accemy</strong> for Kumar Dental Clinic — not a live website.')
    expect(banner).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(html.indexOf('<h1>'))
    expect(html).toContain('href="https://wa.me/919876543210"')
  })

  it('builds the page from the listing and the template for its kind of business', () => {
    const html = render(kumar)
    expect(html).toContain('<h1>Kumar Dental Clinic</h1>')
    expect(html).toContain('Gentle, modern dental care, in Bengaluru')
    expect(html).toContain('★ 4.6')
    expect(html).toContain('1,234 reviews on Google')
    expect(html).toContain('href="tel:+918041234567"')
    expect(html).toContain('>+91 80412 34567</a>')
    expect(html).toContain('href="https://wa.me/918041234567?text=')
    expect(html).toContain('Book an appointment')
    expect(html).toContain('Check-ups and cleaning')
    expect(html).toContain('read 2026-10-07')
  })

  it('claims nothing the listing does not hold — no phone, no rating, no map', () => {
    const html = render({ ...kumar, phone: null, rating: null, reviews: null, mapsUrl: null, address: null, category: 'unknown_type', city: null }, null)
    expect(html).not.toContain('tel:')
    expect(html).not.toContain('wa.me')
    expect(html).not.toContain('★')
    expect(html).not.toContain('Directions')
    expect(html).not.toContain('Like it? Talk to us')
    expect(html).toContain('Serving customers')
    // Nothing in the business's voice that the listing does not support.
    expect(html).not.toMatch(/reply fast|come to you|best in town|number one/i)
  })

  it('never links a map address that is not https', () => {
    expect(render({ ...kumar, mapsUrl: 'javascript:alert(1)' })).not.toContain('javascript:')
  })
})
