/**
 * Where a contact's email and phone came from (0029), on the three screens a
 * person decides from: /contacts, the company page's People and /approvals.
 *
 * The assistant stored addresses it had composed from a name and a domain,
 * and openers bounced off them while nothing on any screen said which
 * addresses anybody could vouch for. The words are core's
 * (`addressSourceWords`); what this file adds — and these tests hold — is the
 * line under each address, the page to open when it was seen on one, the
 * recipient's line on /approvals, and the source a teammate's own edit
 * records, which comes from the session and never from the request body.
 *
 * The routes and the components import `@/…`, so they are pinned by reading
 * their source, as this suite pins every module it cannot import.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { addressSourceWords } from '@agency/core'
import {
  ADDRESS_SOURCE_KIND_WORDS, addressSourceKind, addressSourceLine, contactAddressSources, personAddressSources,
  recipientAddressSource, recipientSourceSentence,
} from '../src/lib/address-source'

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('addressSourceLine', () => {
  it('says what core says, so no screen words a source its own way', () => {
    for (const source of ['person', 'import', 'inbound', 'chat', 'connector:exa', null]) {
      const line = addressSourceLine(source, 'manual')
      expect(line.words).toBe(addressSourceWords(source, 'manual').words)
      expect(line.tone).toBe('ok')
      expect(line.href).toBeNull()
      expect(line.before).toBe('')
      expect(line.linkText).toBe(line.words)
    }
    expect(addressSourceLine('person').words).toBe('typed by a teammate')
    expect(addressSourceLine(null).words).toBe('where it came from was not recorded')
  })

  it('warns about an address the assistant added before sources were kept — the likeliest to be a guess', () => {
    const line = addressSourceLine(null, 'agent')
    expect(line.tone).toBe('warn')
    expect(line.words).toMatch(/added by the assistant before sources were kept — check it before sending/)
    // A teammate's address from before 0029 is unrecorded, never a warning.
    expect(addressSourceLine(null, 'manual').tone).toBe('ok')
    expect(addressSourceLine(undefined, 'import').tone).toBe('ok')
  })

  it('links the page an address was seen on, and only the page', () => {
    const line = addressSourceLine('https://www.127atelier.in/pages/contact/', 'agent')
    expect(line).toEqual({
      words: 'seen on 127atelier.in/pages/contact',
      tone: 'ok',
      href: 'https://www.127atelier.in/pages/contact/',
      before: 'seen on ',
      linkText: '127atelier.in/pages/contact',
    })
    // The page reader reads http too, so its pages are linked as well.
    expect(addressSourceLine('http://example.in/contact').href).toBe('http://example.in/contact')
  })

  it('never links a source that is not a plain web page', () => {
    for (const source of [
      'https://user:secret@example.in/contact', // a credential in the address
      'https://', // no page at all
      'javascript:alert(1)',
      'connector:exa',
      'chat',
    ]) {
      expect(addressSourceLine(source).href, source).toBeNull()
    }
    const withCredential = addressSourceLine('https://user:secret@example.in/contact')
    expect(withCredential.before).toBe('')
    expect(withCredential.linkText).toBe(withCredential.words)
  })

  it('links only a page on the public web, as the Research card does — a click goes from a teammate’s own network', () => {
    for (const source of [
      'http://169.254.169.254/latest/meta-data', // a dotted quad
      'http://127.1/admin', // read by the URL parser as 127.0.0.1
      'http://0x7f.1/', // likewise
      'http://[::1]/', // an IPv6 literal
      'http://router/', // a single-label name
      'http://localhost/contact',
      'https://nas.local/team',
      'https://intranet.corp/people',
      'https://acme.in:8443/contact', // a port no page the reader read can carry
    ]) {
      const line = addressSourceLine(source)
      expect(line.href, source).toBeNull()
      // Still said, as words: where it came from is a fact; only the link is withheld.
      expect(line.words, source).toMatch(/^seen on /)
      expect(line.linkText, source).toBe(line.words)
      // And still a page in the audit row's kind word.
      expect(addressSourceKind(source), source).toBe('page')
    }
    // A public name that merely contains one of those words is linked as any page is.
    expect(addressSourceLine('https://localhost-cafe.in/contact').href).toBe('https://localhost-cafe.in/contact')
    expect(addressSourceLine('https://www.test-kitchen.co/about').href).toBe('https://www.test-kitchen.co/about')
  })
})

describe('contactAddressSources', () => {
  it('gives a line for each address the contact has, and none for one they do not', () => {
    const both = contactAddressSources({
      email: 'info@127atelier.in', phone: '+919876543210',
      emailSource: 'https://127atelier.in/pages/contact', phoneSource: 'chat', source: 'agent',
    })
    expect(both.email?.words).toBe('seen on 127atelier.in/pages/contact')
    expect(both.phone?.words).toBe('typed in chat by the person the assistant was helping')

    const emailOnly = contactAddressSources({ email: 'jo@acme.in', phone: null, emailSource: 'person', source: 'manual' })
    expect(emailOnly.email?.words).toBe('typed by a teammate')
    expect(emailOnly.phone).toBeNull()

    // A row from before 0029 carries no source columns' values at all.
    const old = contactAddressSources({ email: 'akash@farmley.com', phone: null, source: 'agent' })
    expect(old.email?.tone).toBe('warn')
  })
})

describe('recipientAddressSource', () => {
  const contact = {
    email: 'jo@acme.in', phone: '+919876543210', emailSource: 'import', phoneSource: 'person', source: 'import',
  }

  it('reads the address the draft’s channel would use', () => {
    expect(recipientAddressSource('email', contact)).toEqual({
      label: 'Their email address',
      line: expect.objectContaining({ words: 'from an import' }),
    })
    for (const channel of ['sms', 'voice', 'whatsapp']) {
      expect(recipientAddressSource(channel, contact)?.label, channel).toBe('Their number')
      expect(recipientAddressSource(channel, contact)?.line.words, channel).toBe('typed by a teammate')
    }
  })

  it('has nothing to say on LinkedIn, or for a person without the address', () => {
    expect(recipientAddressSource('linkedin', contact)).toBeNull()
    expect(recipientAddressSource('email', { ...contact, email: null })).toBeNull()
    expect(recipientAddressSource('sms', { ...contact, phone: null })).toBeNull()
  })

  it('reads as one sentence where only text fits', () => {
    const r = recipientAddressSource('email', { email: 'akash@farmley.com', phone: null, source: 'agent' })
    expect(r && recipientSourceSentence(r)).toBe(
      'Their email address: added by the assistant before sources were kept — check it before sending',
    )
  })
})

describe('what a teammate’s own edit records', () => {
  it('is `person` beside an address that was given, and nothing beside one that was not', () => {
    expect(personAddressSources({ email: 'jo@acme.in', phone: '+919876543210' })).toEqual({
      emailSource: 'person', phoneSource: 'person',
    })
    expect(personAddressSources({ email: 'jo@acme.in' })).toEqual({ emailSource: 'person', phoneSource: null })
    expect(personAddressSources({ email: '   ', phone: null })).toEqual({ emailSource: null, phoneSource: null })
  })

  it('is a kind word in the audit row, never the source itself', () => {
    expect(addressSourceKind('person')).toBe('person')
    expect(addressSourceKind('chat')).toBe('chat')
    expect(addressSourceKind('connector:apollo')).toBe('connector')
    expect(addressSourceKind('https://acme.in/team/jo')).toBe('page')
    expect(addressSourceKind(null)).toBeNull()
    expect(addressSourceKind('import')).toBeNull()
    expect(addressSourceKind('https://user:pw@acme.in/')).toBeNull()
    for (const kind of ['person', 'chat', 'connector', 'page'] as const) {
      expect(ADDRESS_SOURCE_KIND_WORDS[kind]).not.toMatch(/https?:|@/)
    }
  })
})

describe('the contacts routes take the source from the session, never the body', () => {
  it('POST overrides any source the body named, after the body is spread', () => {
    const route = src('app/api/contacts/route.ts')
    expect(route).toContain('createContact(db, user.orgId, { ...parsed.data, ...personAddressSources(parsed.data) })')
    // The audit row says where each address came from by KIND, never the value.
    expect(route).toContain('emailSourceKind: addressSourceKind(result.contact.emailSource)')
    expect(route).toContain('phoneSourceKind: addressSourceKind(result.contact.phoneSource)')
    expect(route).not.toMatch(/detail: \{[^}]*emailSource:/)
  })

  it('PATCH records a changed address as a teammate’s, overriding the body', () => {
    const route = src('app/api/contacts/[id]/route.ts')
    expect(route).toContain("contactsUpdate(db, user.orgId, id, { ...parsed.data, emailSource: 'person', phoneSource: 'person' })")
  })
})

describe('every screen that shows an address shows where it came from, under it', () => {
  const LINK = /<a href=\{(\w+)\.href\} target="_blank" rel="noopener noreferrer nofollow" title=\{\1\.href\}>/

  it('on /contacts, under the email and under the phone', () => {
    const page = src('app/contacts/page.tsx')
    expect(page).toContain('const from = contactAddressSources(r)')
    expect(page).toMatch(/emailFrom: from\.email,\s*phoneFrom: from\.phone,/)
    const ledger = src('components/contacts/ledger.tsx')
    expect(ledger).toMatch(/<code>\{r\.email\}<\/code>\s*<AddressFrom from=\{r\.emailFrom\} \/>/)
    expect(ledger).toMatch(/<code>\{r\.phone\}<\/code>\s*<AddressFrom from=\{r\.phoneFrom\} \/>/)
    expect(ledger).toMatch(LINK)
    expect(ledger).toContain("from.tone === 'warn' ? 'address-source err-line' : 'address-source'")
  })

  it('on the company page’s People', () => {
    const page = src('app/companies/[domain]/page.tsx')
    expect(page).toContain('const from = contactAddressSources(c)')
    expect(page).toMatch(/emailFrom: from\.email,\s*phoneFrom: from\.phone,/)
    const panel = src('components/outreach/contacts.tsx')
    expect(panel).toMatch(/<code>\{c\.email\}<\/code>\s*<AddressFrom from=\{c\.emailFrom\} \/>/)
    expect(panel).toMatch(/<code>\{c\.phone\}<\/code>\s*<AddressFrom from=\{c\.phoneFrom\} \/>/)
    expect(panel).toMatch(LINK)
    expect(panel).toContain("from.tone === 'warn' ? 'address-source err-line' : 'address-source'")
  })

  it('on /approvals, beside the chosen recipient and never inside an <option>, which holds text', () => {
    const page = src('app/approvals/page.tsx')
    expect(page).toContain('addressSource: recipientAddressSource(d.touch.channel, c)')
    const card = src('components/outreach/drafts.tsx')
    expect(card).toContain('{chosenPerson?.addressSource ? <RecipientFrom source={chosenPerson.addressSource} /> : null}')
    expect(card).toMatch(LINK)
    expect(card).toContain("line.tone === 'warn' ? 'address-source err-line' : 'address-source'")
    const option = /<option\s[^>]*key=\{c\.id\}[\s\S]*?<\/option>/.exec(card)?.[0] ?? ''
    expect(option).toContain('{c.label}')
    expect(option).not.toMatch(/addressSource|RecipientFrom/)
  })

  it('has a style for the line, and its warning wears the warning colour', () => {
    const css = src('app/globals.css')
    expect(css).toMatch(/\.address-source \{[^}]*font-size: 11\.5px/)
    expect(css).toMatch(/\.address-source\.err-line \{ color: var\(--warn\); \}/)
  })
})
