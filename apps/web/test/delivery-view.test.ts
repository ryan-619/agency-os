import { describe, expect, it } from 'vitest'
import { deliveryLine } from '../src/lib/delivery-view'

const AT = new Date('2026-10-01T06:30:00Z')
const out = { direction: 'out', deliveryStatus: null, deliveredAt: null, deliveryError: null } as const

describe('deliveryLine — what an SMS delivery report says (0019)', () => {
  it('says nothing when no report has come, or for a reply', () => {
    expect(deliveryLine(out)).toBeNull()
    expect(deliveryLine({ ...out, direction: 'in', deliveryStatus: 'delivered', deliveredAt: AT })).toBeNull()
  })

  it('says delivered, with the handset’s time for the page to render', () => {
    expect(deliveryLine({ ...out, deliveryStatus: 'delivered', deliveredAt: AT })).toEqual({
      tone: 'ok', text: 'Delivered to the handset', at: AT,
    })
  })

  it('says a pending report is not a delivery', () => {
    expect(deliveryLine({ ...out, deliveryStatus: 'pending' })?.text).toBe(
      'The operator has it; no final delivery report yet.',
    )
  })

  it('names the operator’s reason for a failure, and that it suppresses nobody', () => {
    const l = deliveryLine({ ...out, deliveryStatus: 'failed', deliveryError: 'EXPIRED' })
    expect(l?.tone).toBe('warn')
    expect(l?.text).toBe('Not delivered: EXPIRED. A failed delivery is about the number on this attempt; it suppresses nobody.')
  })

  it('does not guess at a value outside the CHECK', () => {
    expect(deliveryLine({ ...out, deliveryStatus: 'read' })).toBeNull()
  })
})
