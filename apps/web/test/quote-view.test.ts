/**
 * What a quote document shows about paying and answering (`lib/quote-view`).
 */
import { describe, expect, it } from 'vitest'
import { buyerQuoteClosed, qrSvg, quotePayment, unitWords } from '../src/lib/quote-view'

const seller = {
  name: 'Accemy', legalName: 'Accemy Digital LLP', address: null, phone: null, email: null, website: null,
  gstin: null, upiVpa: 'accemy@okhdfcbank', upiPayee: null, brochureUrl: null,
}

describe('quotePayment', () => {
  it('gives the UPI link and its QR code for the advance, paid to the legal name when no payee is set', () => {
    const p = quotePayment({ seller, advanceAmount: 8_850, currency: 'INR', number: 'Q-2026-0001' })
    expect(p).not.toBeNull()
    expect(p!.uri).toBe('upi://pay?pa=accemy%40okhdfcbank&pn=Accemy%20Digital%20LLP&am=8850.00&cu=INR&tn=Advance%20Q-2026-0001')
    expect(p!.svg.startsWith('<svg')).toBe(true)
    expect(p!.payee).toBe('Accemy Digital LLP')
  })

  it('gives nothing without a UPI ID, an advance, or rupees', () => {
    expect(quotePayment({ seller: { ...seller, upiVpa: null }, advanceAmount: 100, currency: 'INR', number: 'Q' })).toBeNull()
    expect(quotePayment({ seller, advanceAmount: 0, currency: 'INR', number: 'Q' })).toBeNull()
    expect(quotePayment({ seller, advanceAmount: 100, currency: 'USD', number: 'Q' })).toBeNull()
  })

  it('draws a QR code with nothing fetched', () => {
    expect(qrSvg('upi://pay?pa=a%40b')).toMatch(/^<svg[\s\S]*<\/svg>$/)
  })
})

describe('the buyer’s page', () => {
  it('says why a quote cannot be accepted, and nothing for one that can', () => {
    expect(buyerQuoteClosed('sent', false)).toBeNull()
    expect(buyerQuoteClosed('sent', true)).toMatch(/validity has passed/)
    expect(buyerQuoteClosed('accepted', false)).toMatch(/You accepted/)
    expect(buyerQuoteClosed('withdrawn', false)).toMatch(/no longer open/)
    expect(buyerQuoteClosed('draft', false)).toMatch(/no longer open/)
    expect(buyerQuoteClosed('declined', false)).toMatch(/declined/)
  })

  it('words a unit', () => {
    expect(unitWords('monthly')).toBe('per month')
    expect(unitWords('odd')).toBe('odd')
  })
})
