/**
 * /settings/mail's reading of the agency's own DNS (§2.2, §2.3).
 *
 * The rule these tests exist for: a lookup that FAILED is "could not be
 * checked", never "missing". SERVFAIL and a timeout say nothing about the
 * record; only NODATA and NXDOMAIN are answers. A page that turned a resolver
 * hiccup into "you have no DMARC" would be stating a finding it did not
 * observe — about ourselves, which is no better than about a prospect.
 *
 * The rest pin the parsing where real records are awkward — SPF split into
 * 255-byte chunks, DMARC with odd spacing and case — and the one piece of
 * user input: a DKIM selector must be a single DNS label before it is ever
 * put in front of `._domainkey.`.
 */
import { describe, expect, it } from 'vitest'
import {
  DKIM_DEFAULT_SELECTORS, MAIL_DNS_VERDICT_WORDS, assessMailDns, isDkimSelector, lookupMailDns, mailFromDomain,
  parseDkim, parseDmarc, parseSpf, txtAnswerFromError, txtAnswerFromRecords, type ResolveTxt, type TxtAnswer,
} from '../src/lib/mail-dns'

const records = (...r: string[]): TxtAnswer => ({ kind: 'records', records: r })
const ABSENT: TxtAnswer = { kind: 'absent' }
const SERVFAIL: TxtAnswer = { kind: 'unchecked', code: 'ESERVFAIL' }
/** A 2048-bit RSA SubjectPublicKeyInfo is 294 bytes: 392 base64 characters. */
const KEY_2048 = 'M' + 'A'.repeat(391)
/** A 1024-bit one is 162 bytes: 216 characters. */
const KEY_1024 = 'M' + 'A'.repeat(215)

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code} example`), { code })
}

describe('isDkimSelector', () => {
  it('accepts a single DNS label', () => {
    for (const s of ['resend', 'google', 'selector1', 's1', 'k-2024', 'A1']) expect(isDkimSelector(s), s).toBe(true)
  })

  /** Each of these would build a name somewhere other than `<label>._domainkey.<our domain>`. */
  it('refuses anything that is not exactly one label', () => {
    for (const s of [
      '', 'a.b', 'evil.com.', '-lead', 'trail-', 'with space', 'under_score', 'x'.repeat(64),
      '169.254.169.254', 'a/b', '*', 'sel\n', '%2e',
    ]) {
      expect(isDkimSelector(s), JSON.stringify(s)).toBe(false)
    }
    expect(isDkimSelector('x'.repeat(63))).toBe(true)
  })
})

describe('mailFromDomain', () => {
  it('reads the domain from a display-name address or a bare one', () => {
    expect(mailFromDomain('Agency OS <hello@Agency.example.com>')).toEqual({ domain: 'agency.example.com' })
    expect(mailFromDomain('hello@myagencyos.in')).toEqual({ domain: 'myagencyos.in' })
    expect(mailFromDomain('  "Sales" <sales@mail.myagencyos.in.>  ')).toEqual({ domain: 'mail.myagencyos.in' })
  })

  it('has nothing public to check for the development default', () => {
    expect(mailFromDomain('Agency OS <agency-os@localhost>')).toEqual({ domain: null, reason: 'local' })
    expect(mailFromDomain('x@mailpit.local')).toEqual({ domain: null, reason: 'local' })
    expect(mailFromDomain('x@agency.test')).toEqual({ domain: null, reason: 'local' })
  })

  it('refuses what is not an address with a DNS name', () => {
    expect(mailFromDomain('Agency OS')).toEqual({ domain: null, reason: 'no_address' })
    expect(mailFromDomain('x@127.0.0.1')).toEqual({ domain: null, reason: 'no_address' })
    expect(mailFromDomain('x@bad_domain.com')).toEqual({ domain: null, reason: 'no_address' })
  })
})

describe('txtAnswerFromError', () => {
  it('treats NODATA and NXDOMAIN as answers', () => {
    expect(txtAnswerFromError(dnsError('ENODATA'))).toEqual({ kind: 'absent' })
    expect(txtAnswerFromError(dnsError('ENOTFOUND'))).toEqual({ kind: 'absent' })
  })

  it('treats every other failure as not an observation, naming the code', () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED', 'EBADRESP', 'ECANCELLED']) {
      expect(txtAnswerFromError(dnsError(code))).toEqual({ kind: 'unchecked', code })
    }
  })

  it('never passes anything but a resolver-shaped code through', () => {
    expect(txtAnswerFromError(new Error('boom'))).toEqual({ kind: 'unchecked', code: 'EUNKNOWN' })
    expect(txtAnswerFromError({ code: 'postgres://user:pw@host/db' })).toEqual({ kind: 'unchecked', code: 'EUNKNOWN' })
    expect(txtAnswerFromError(null)).toEqual({ kind: 'unchecked', code: 'EUNKNOWN' })
  })
})

describe('parseSpf', () => {
  /** RFC 7208 §3.3: a record's chunks join with nothing between them. */
  it('joins a record split into chunks before reading it', () => {
    const answer = txtAnswerFromRecords([['v=spf1 include:_spf.goo', 'gle.com include:amazonses.com -a', 'll']])
    expect(answer).toEqual({ kind: 'records', records: ['v=spf1 include:_spf.google.com include:amazonses.com -all'] })
    const spf = parseSpf(answer.kind === 'records' ? answer.records : [])
    expect(spf.all).toBe('-all')
    expect(spf.records).toHaveLength(1)
  })

  it('reads the all mechanism, -all ~all ?all +all and none', () => {
    expect(parseSpf(['v=spf1 mx -all']).all).toBe('-all')
    expect(parseSpf(['v=spf1 mx ~all']).all).toBe('~all')
    expect(parseSpf(['v=spf1 mx ?all']).all).toBe('?all')
    expect(parseSpf(['v=spf1 mx all']).all).toBe('+all')
    expect(parseSpf(['V=SPF1 MX -ALL']).all).toBe('-all')
    expect(parseSpf(['v=spf1 mx']).all).toBeNull()
  })

  it('ignores TXT that is not SPF, and a version that only starts with spf1', () => {
    const spf = parseSpf(['google-site-verification=abc', 'v=spf10 -all', 'v=spf1 -all'])
    expect(spf.records).toEqual(['v=spf1 -all'])
  })

  it('notes a redirect', () => {
    expect(parseSpf(['v=spf1 redirect=_spf.example.net']).redirect).toBe('_spf.example.net')
  })
})

describe('parseDmarc', () => {
  it('reads p= through odd spacing and case', () => {
    expect(parseDmarc(['v=DMARC1; p=reject; rua=mailto:d@x.com']).policy).toBe('reject')
    expect(parseDmarc(['v=DMARC1;p=QUARANTINE']).policy).toBe('quarantine')
    expect(parseDmarc(['  v = DMARC1 ;   P = None ;  ']).policy).toBe('none')
    expect(parseDmarc(['v=dmarc1; p=Reject']).policy).toBe('reject')
  })

  it('refuses a record whose first tag is not the version, and an unknown policy', () => {
    expect(parseDmarc(['p=reject; v=DMARC1']).records).toEqual([])
    expect(parseDmarc(['v=DMARC1; p=block']).policy).toBeNull()
    expect(parseDmarc(['v=DMARC1']).policy).toBeNull()
  })

  it('reads pct, clamped, and whether reports are asked for', () => {
    expect(parseDmarc(['v=DMARC1; p=reject; pct=25'])).toMatchObject({ pct: 25, reports: false })
    expect(parseDmarc(['v=DMARC1; p=reject; pct=250']).pct).toBe(100)
    expect(parseDmarc(['v=DMARC1; p=reject; pct=abc']).pct).toBe(100)
    expect(parseDmarc(['v=DMARC1; p=none; rua=mailto:a@b.c']).reports).toBe(true)
  })
})

describe('parseDkim', () => {
  it('reads a published key, a short one, a revoked one, and TXT that is no key', () => {
    expect(parseDkim([`v=DKIM1; k=rsa; p=${KEY_2048}`])).toBe('found')
    expect(parseDkim([`v=DKIM1; p=${KEY_1024}`])).toBe('short')
    expect(parseDkim(['v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo='])).toBe('found')
    expect(parseDkim(['v=DKIM1; p='])).toBe('revoked')
    expect(parseDkim(['some-other-verification=1'])).toBe('none')
  })
})

describe('assessMailDns', () => {
  const OK_DKIM = [{ selector: 'resend', answer: records(`p=${KEY_2048}`) }]

  it('passes a domain that publishes all three', () => {
    const a = assessMailDns({ spf: records('v=spf1 include:amazonses.com -all'), dmarc: records('v=DMARC1; p=reject'), dkim: OK_DKIM })
    expect([a.spf.verdict, a.dmarc.verdict, a.dkim.verdict]).toEqual(['pass', 'pass', 'pass'])
    expect(a.spf.record).toBe('v=spf1 include:amazonses.com -all')
    expect(a.dkim.detail).toMatch(/resend/)
  })

  it('grades SPF by its all mechanism', () => {
    const spf = (r: string) => assessMailDns({ spf: records(r), dmarc: ABSENT, dkim: OK_DKIM }).spf
    expect(spf('v=spf1 mx -all').verdict).toBe('pass')
    expect(spf('v=spf1 mx ~all').verdict).toBe('pass')
    expect(spf('v=spf1 mx ?all').verdict).toBe('weak')
    expect(spf('v=spf1 +all').verdict).toBe('weak')
    expect(spf('v=spf1 mx').verdict).toBe('weak')
    expect(spf('v=spf1 redirect=_spf.example.net').verdict).toBe('unchecked')
  })

  it('calls two SPF records weak, not pass', () => {
    const a = assessMailDns({ spf: records('v=spf1 -all', 'v=spf1 mx -all'), dmarc: ABSENT, dkim: OK_DKIM })
    expect(a.spf.verdict).toBe('weak')
    expect(a.spf.detail).toMatch(/permanent error/)
  })

  it('grades DMARC by p= and pct', () => {
    const dmarc = (r: string) => assessMailDns({ spf: ABSENT, dmarc: records(r), dkim: OK_DKIM }).dmarc.verdict
    expect(dmarc('v=DMARC1; p=reject')).toBe('pass')
    expect(dmarc('v=DMARC1; p=quarantine')).toBe('pass')
    expect(dmarc('v=DMARC1; p=quarantine; pct=50')).toBe('weak')
    expect(dmarc('v=DMARC1; p=none; rua=mailto:x@y.z')).toBe('weak')
    expect(dmarc('v=DMARC1')).toBe('weak')
  })

  it('calls an authoritative absence missing', () => {
    const a = assessMailDns({ spf: ABSENT, dmarc: records('google-site-verification=x'), dkim: [{ selector: 'resend', answer: ABSENT }] })
    expect([a.spf.verdict, a.dmarc.verdict, a.dkim.verdict]).toEqual(['missing', 'missing', 'missing'])
  })

  /** The rule. A failed lookup is not an observation of anything. */
  it('calls a failed lookup "could not be checked", never missing', () => {
    const a = assessMailDns({ spf: SERVFAIL, dmarc: { kind: 'unchecked', code: 'ETIMEOUT' }, dkim: [{ selector: 'resend', answer: SERVFAIL }] })
    expect([a.spf.verdict, a.dmarc.verdict, a.dkim.verdict]).toEqual(['unchecked', 'unchecked', 'unchecked'])
    expect(a.spf.detail).toMatch(/ESERVFAIL/)
    expect(a.dmarc.detail).toMatch(/ETIMEOUT/)
    for (const r of [a.spf, a.dmarc, a.dkim]) expect(r.detail).not.toMatch(/^No /)
    expect(MAIL_DNS_VERDICT_WORDS.unchecked).toBe('could not be checked')
  })

  /**
   * One selector answered "absent" and another failed. The failed one may be
   * where the key lives, so the whole answer is unknown — not missing.
   */
  it('does not call DKIM missing while any selector could not be checked', () => {
    const a = assessMailDns({
      spf: ABSENT, dmarc: ABSENT,
      dkim: [{ selector: 'resend', answer: ABSENT }, { selector: 'google', answer: SERVFAIL }],
    })
    expect(a.dkim.verdict).toBe('unchecked')
    expect(a.dkim.selectors).toEqual([
      { selector: 'resend', state: 'absent' },
      { selector: 'google', state: 'unchecked', code: 'ESERVFAIL' },
    ])
  })

  it('says a missing DKIM key means only "not at the selectors tried"', () => {
    const a = assessMailDns({
      spf: ABSENT, dmarc: ABSENT,
      dkim: DKIM_DEFAULT_SELECTORS.map((selector) => ({ selector, answer: ABSENT })),
    })
    expect(a.dkim.verdict).toBe('missing')
    expect(a.dkim.detail).toContain('resend, google, default, selector1, selector2')
    expect(a.dkim.detail).toMatch(/not ruled out/)
  })

  it('grades a short key weak and names a revoked one', () => {
    expect(assessMailDns({ spf: ABSENT, dmarc: ABSENT, dkim: [{ selector: 's1', answer: records(`p=${KEY_1024}`) }] }).dkim.verdict).toBe('weak')
    const revoked = assessMailDns({ spf: ABSENT, dmarc: ABSENT, dkim: [{ selector: 's1', answer: records('v=DKIM1; p=') }] }).dkim
    expect(revoked.verdict).toBe('missing')
    expect(revoked.detail).toMatch(/s1 publishes a revoked key/)
  })
})

describe('lookupMailDns', () => {
  /** A resolver that answers from a table and fails the way node:dns does for everything else. */
  function fakeResolver(table: Record<string, string[][] | string>): { resolve: ResolveTxt; asked: string[] } {
    const asked: string[] = []
    const resolve: ResolveTxt = async (name) => {
      asked.push(name)
      const v = table[name]
      if (v === undefined) throw dnsError('ENOTFOUND')
      if (typeof v === 'string') throw dnsError(v)
      return v
    }
    return { resolve, asked }
  }

  it('asks only for the domain, its _dmarc and each selector under _domainkey', async () => {
    const { resolve, asked } = fakeResolver({
      'agency.com': [['v=spf1 -all']],
      '_dmarc.agency.com': [['v=DMARC1; p=reject']],
      'resend._domainkey.agency.com': [[`p=${KEY_2048}`]],
    })
    const r = await lookupMailDns('agency.com', ['resend', 'Google'], resolve)
    expect(asked.sort()).toEqual(
      ['_dmarc.agency.com', 'agency.com', 'google._domainkey.agency.com', 'resend._domainkey.agency.com'].sort(),
    )
    expect(r.domain).toBe('agency.com')
    expect([r.spf.verdict, r.dmarc.verdict, r.dkim.verdict]).toEqual(['pass', 'pass', 'pass'])
  })

  /** End to end, through the resolver's own error shape. */
  it('turns a SERVFAIL into "could not be checked" for that record alone', async () => {
    const { resolve } = fakeResolver({
      'agency.com': 'ESERVFAIL',
      '_dmarc.agency.com': [['v=DMARC1; p=none']],
      'resend._domainkey.agency.com': 'ETIMEOUT',
    })
    const r = await lookupMailDns('agency.com', ['resend'], resolve)
    expect(r.spf.verdict).toBe('unchecked')
    expect(r.dmarc.verdict).toBe('weak')
    expect(r.dkim.verdict).toBe('unchecked')
  })

  it('refuses to build a name from a selector that is not one label', async () => {
    const { resolve, asked } = fakeResolver({})
    await expect(lookupMailDns('agency.com', ['evil.com.'], resolve)).rejects.toThrow(/single DNS label/)
    expect(asked).toEqual([])
  })
})
