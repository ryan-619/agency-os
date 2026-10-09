/**
 * Settings → Services and the company page's needs panel (0022).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { priceLine } from '../src/lib/service-price'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('a service’s price in words', () => {
  it('reads a range, a floor, a ceiling and no price, with Indian grouping for rupees', () => {
    expect(priceLine({ priceFrom: 15000, priceTo: 40000, currency: 'INR', priceUnit: 'one_off' })).toBe('INR 15,000–40,000 one-off')
    expect(priceLine({ priceFrom: 150000, priceTo: 150000, currency: 'INR', priceUnit: 'yearly' })).toBe('INR 1,50,000 a year')
    expect(priceLine({ priceFrom: 8000, priceTo: null, currency: 'INR', priceUnit: 'monthly' })).toBe('from INR 8,000 a month')
    expect(priceLine({ priceFrom: null, priceTo: 500, currency: 'USD', priceUnit: 'hourly' })).toBe('up to USD 500 an hour')
    expect(priceLine({ priceFrom: null, priceTo: null, currency: 'INR', priceUnit: 'one_off' })).toBe('no price set')
  })
})

describe('the catalogue’s routes and pages', () => {
  it('lets the team read the catalogue and only an owner change it', () => {
    const rules = source('../src/app/api/services/rules.ts')
    expect(rules).toMatch(/mayReadServices = \(p: Principal\): boolean => can\(p, 'companies:read'\)/)
    expect(rules).toMatch(/mayWriteServices = \(p: Principal\): boolean => can\(p, 'agents:write'\)/)
    for (const route of ['../src/app/api/services/route.ts', '../src/app/api/services/[id]/route.ts', '../src/app/api/services/suggested/route.ts']) {
      expect(source(route), route).toMatch(/mayWriteServices\(/)
    }
  })

  it('shows what a business needs on its page, and never a placeholder as a domain', () => {
    const page = source('../src/app/companies/[domain]/page.tsx')
    expect(page).toMatch(/<OpportunitiesSlot \{\.\.\.slot\} \/>/)
    expect(page).toMatch(/isNoSiteDomain\(company\.domain\) \? <span>no website of its own<\/span>/)
    const list = source('../src/app/companies/page.tsx')
    expect(list).toMatch(/isNoSiteDomain\(r\.domain\) \? 'no website' : r\.domain/)
    // A client module's export cannot be called on the server: the price words live in lib/.
    expect(source('../src/components/company/opportunities.tsx')).toMatch(/from '@\/lib\/service-price'/)
  })

  it('makes a call or a visit by hand, and nothing the system makes', () => {
    const route = source('../src/app/api/tasks/route.ts')
    expect(route).toMatch(/kind !== 'todo' && kind !== 'call' && kind !== 'visit'/)
  })
})
