/** The website preview's words for a kind of business (`src/site-preview.ts`). */
import { describe, expect, it } from 'vitest'
import { phoneForDisplay, siteTagline, siteTemplateFor, whatsappLink } from '../src/index.js'

describe('siteTemplateFor', () => {
  it('fits the template to the Google category, through its aliases, and falls back for anything else', () => {
    expect(siteTemplateFor('dentist').kind).toBe('Dental clinic')
    expect(siteTemplateFor('dental_clinic').kind).toBe('Dental clinic')
    expect(siteTemplateFor('barber_shop').kind).toBe('Hair salon')
    expect(siteTemplateFor('something_new').kind).toBe('Business')
    expect(siteTemplateFor(null).kind).toBe('Business')
    // An inherited name is not a category.
    expect(siteTemplateFor('constructor').kind).toBe('Business')
    expect(siteTemplateFor('toString').kind).toBe('Business')
  })

  it('offers example services of the kind, never a price', () => {
    const t = siteTemplateFor('restaurant')
    expect(t.services.length).toBeGreaterThanOrEqual(4)
    expect(t.services.join(' ')).not.toMatch(/₹|\d{3,}/)
  })
})

describe('siteTagline and whatsappLink', () => {
  it('puts the city in, or drops the clause', () => {
    expect(siteTagline(siteTemplateFor('dentist'), 'Pune')).toBe('Gentle, modern dental care, in Pune')
    expect(siteTagline(siteTemplateFor('dentist'), '  ')).toBe('Gentle, modern dental care')
  })

  it('links WhatsApp only for an E.164 number', () => {
    expect(whatsappLink('+919876543210', 'Hi')).toBe('https://wa.me/919876543210?text=Hi')
    expect(whatsappLink('9876543210')).toBeNull()
    expect(whatsappLink(null)).toBeNull()
  })
})

describe('phoneForDisplay', () => {
  it('spaces an Indian number as people write it, and leaves any other as stored', () => {
    expect(phoneForDisplay('+919876543210')).toBe('+91 98765 43210')
    expect(phoneForDisplay('+918041234567')).toBe('+91 80412 34567')
    expect(phoneForDisplay('+14155550123')).toBe('+14155550123')
    expect(phoneForDisplay('+9180412345')).toBe('+9180412345')
  })
})
