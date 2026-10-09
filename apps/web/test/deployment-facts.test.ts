/**
 * /settings/deployment's DoveSoft facts after review round 6, finding [22].
 *
 * The page said every text "is filed under the contact whose number it came
 * from", and nothing about a number several contacts share — filed under
 * the one this system texted, or under nobody with every holder paused and
 * their waiting messages cancelled. And DOVESOFT_ORG_ID, which round 5 made
 * the tie-break between two orgs that had both texted a number, is the home
 * of a number nobody holds and nothing else: every org texts through the
 * one account, so it is no evidence of whose a reply is.
 */
import { describe, expect, it } from 'vitest'
import { dovesoftFacts } from '../src/lib/deployment-facts'

describe('dovesoftFacts on a number several contacts share', () => {
  const base = { AUTH_URL: 'https://myagencyos.in', DOVESOFT_WEBHOOK_SECRET: 'S'.repeat(40), DOVESOFT_ORG_ID: undefined }
  const ORG = '0b0e5a4e-7d1c-4c8e-9a51-1f7d1c0c0001'

  it.each([undefined, ORG])('says how a shared number is filed and held, whether or not the org is named (%s)', (org) => {
    const all = dovesoftFacts({ ...base, DOVESOFT_ORG_ID: org }).sentences.join(' ')
    expect(all).toContain('A number several contacts share is filed under the one this system texted at it')
    expect(all).toContain('every other contact holding it is paused and their waiting messages cancelled')
    expect(all).toContain('When this system texted none of them, or more than one, it is filed under nobody')
    expect(all).toContain('every contact holding the number is paused and their waiting messages cancelled')
    expect(all).toContain('/contacts')
  })

  it('says DOVESOFT_ORG_ID decides nothing about a number a contact holds, only where a number nobody holds goes', () => {
    const on = dovesoftFacts({ ...base, DOVESOFT_ORG_ID: ORG }).sentences[1] ?? ''
    expect(on).toContain('DOVESOFT_ORG_ID decides nothing about a number a contact holds')
    expect(on).toContain('Only a text from a number no contact anywhere holds')
    const all = dovesoftFacts({ ...base, DOVESOFT_ORG_ID: ORG }).sentences.join(' ')
    expect(all).not.toMatch(/prefer/i)
  })

  it('keeps the sending sentence last', () => {
    expect(dovesoftFacts(base).sentences.at(-1)).toContain('Sending is the worker’s')
  })
})
