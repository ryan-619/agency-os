/**
 * What a buyer holding a share link is shown (PROMPT.md §8.6, under §2.2).
 *
 * The buyer's page renders the stored proposal through `<ProposalDocument
 * audience="buyer">`, and every sentence around it comes from
 * `proposal-share-copy.ts`. Three promises, each pinned here:
 *
 *   * the buyer's document carries no score, no tier, no weight and never
 *     the word "stale" — rendered for real, to a string, with a document
 *     that HAS all four, beside the team's render that shows them (so the
 *     test can see what it asserts is absent);
 *   * no sentence a buyer can be shown says "stale", a score or a tier: a
 *     proposal whose evidence aged out is "being re-verified";
 *   * the Slack event an acceptance posts carries ids and a domain, never
 *     the name the buyer typed.
 *
 * The last block reads the public page's and the accept route's source for
 * the rules a render cannot show: both are dynamic on the Node runtime (a
 * cached public page keeps serving a revoked link), the body is read as
 * text and bounded before it is parsed, and the answer names no id.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Proposal } from '@agency/core'
import type { ShareAcceptResult } from '@agency/db/queries'
import { ProposalDocument } from '../src/components/pipeline/proposal-document'
import {
  BUYER_ACCEPT_HEADING, BUYER_AUTHORITY, BUYER_CLOSED, BUYER_REFUSAL, SHARE_EXPLAINER, buyerAccepted, buyerBasis,
  buyerClosed, buyerReverifying, shareCreateBlocked, shareState,
} from '../src/components/pipeline/proposal-share-copy'
import { shareAcceptedNotification } from '../src/app/api/p/[token]/accept/notification'
import { slackMessage } from '../src/lib/slack-message'

// vitest compiles the app's .tsx with the classic JSX runtime — the app's
// tsconfig says `jsx: preserve`, which Next honours and vite does not — so a
// compiled component calls `React.createElement` on a global at render time.
;(globalThis as { React?: typeof React }).React = React

const HERE = dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string => readFileSync(resolve(HERE, '../src', rel), 'utf8')

/** A stored proposal, with everything the team sees and the buyer must not. */
const DOC: Proposal = {
  title: 'Application security posture remediation for Rentman',
  summary: 'On 2026-09-01 Northwind Security reviewed rentman.io from the outside. Of 11 signals observed, 2 were gaps.',
  basedOn: { scanRanAt: '2026-09-01T08:00:00.000Z', score: 77, tier: 'A — call first' },
  workstreams: [
    {
      name: 'Security headers baseline',
      summary: 'Define, stage and roll out the browser-side protections the site currently lacks.',
      effortDays: { low: 3, high: 5 },
      items: [
        {
          signalKey: 'csp',
          workstream: 'Security headers baseline',
          deliverable: 'A Content-Security-Policy, deployed report-only first, then enforced.',
          why: 'No Content-Security-Policy — the loudest AppSec tell on a login-bearing app',
          weight: 15,
          evidence: ['content-security-policy: (absent)'],
        },
      ],
    },
  ],
  alreadyInPlace: [{ signalKey: 'hsts', why: 'No Strict-Transport-Security — trivially fixed' }],
  notAssessed: [{ signalKey: 'trust_page', why: 'No /security or /trust page' }],
  assumptions: ['Scope is limited to what was observed from the outside on the date above.'],
  pricing: { currency: 'USD', dayRate: 1200, effortDays: { low: 3, high: 5 }, total: { low: 3600, high: 6000 } },
  generatedAt: '2026-09-02T08:00:00.000Z',
}

const render = (audience: 'team' | 'buyer', over: { status?: string; evidenceStale?: boolean } = {}): string =>
  renderToStaticMarkup(
    React.createElement(ProposalDocument, {
      doc: DOC,
      company: { domain: 'rentman.io', name: 'Rentman' },
      agency: { name: 'Northwind Security' },
      status: over.status ?? 'sent',
      evidenceAsOf: '2026-09-01T08:00:00.000Z',
      evidenceStale: over.evidenceStale ?? true,
      audience,
    }),
  )

/** Visible text only — attribute values and tags stripped. */
const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('the buyer’s document', () => {
  it('the team’s render shows the score, the tier, the weights and the stale mark — so their absence below means something', () => {
    const team = text(render('team'))
    expect(team).toContain('/100')
    expect(team).toMatch(/tier/i)
    expect(team).toMatch(/stale/i)
    expect(team).toMatch(/weight 15/)
  })

  it('carries no score, no tier, no weight and never the word stale — even handed a stale flag', () => {
    for (const status of ['sent', 'accepted', 'declined', 'withdrawn']) {
      const html = render('buyer', { status, evidenceStale: true })
      const buyer = text(html)
      expect(buyer, status).not.toContain('/100')
      expect(buyer, status).not.toMatch(/\btier\b/i)
      expect(buyer, status).not.toMatch(/stale/i)
      expect(buyer, status).not.toMatch(/\bweight\b/i)
      expect(buyer, status).not.toContain('77')
      expect(buyer, status).not.toContain('call first')
      // …and not in the markup either, where an attribute could carry it.
      expect(html, status).not.toMatch(/stale|\/100|call first/i)
      expect(html, status).not.toContain('note-warn')
    }
  })

  it('keeps what §2.2 insists on, verbatim: the evidence, "not the case here", and "not assessed"', () => {
    const buyer = text(render('buyer'))
    expect(buyer).toContain('content-security-policy: (absent)')
    expect(buyer).toContain('not the case here')
    expect(buyer).toContain('Not assessed')
    expect(buyer).toContain('not assumed to be fine')
    expect(buyer).toContain('posture review from the outside, not a security test')
    expect(buyer).toContain('Prepared by Northwind Security for Rentman')
  })
})

describe('what a buyer can be told', () => {
  const everything = [
    ...Object.values(BUYER_REFUSAL),
    ...Object.values(BUYER_CLOSED),
    ...['sent', 'accepted', 'declined', 'withdrawn', 'draft', 'constructor'].map(buyerClosed),
    buyerReverifying('Northwind Security'),
    buyerBasis('rentman.io', '2026-09-01'),
    buyerAccepted('Northwind Security'),
    BUYER_AUTHORITY,
    BUYER_ACCEPT_HEADING,
  ]

  it('never says stale, a score or a tier — aged evidence is "being re-verified"', () => {
    for (const s of everything) {
      expect(s).not.toMatch(/stale|score|\btier\b|\/100/i)
      expect(s.length).toBeGreaterThan(8)
    }
    expect(buyerReverifying('Northwind Security')).toContain('being re-verified')
    expect(BUYER_REFUSAL.reverifying).toContain('being re-verified')
  })

  it('answers revoked exactly as it answers unknown', () => {
    expect(BUYER_REFUSAL.revoked).toBe(BUYER_REFUSAL.not_found)
  })

  it('says what accepting means, and on what basis', () => {
    expect(BUYER_AUTHORITY).toBe('By accepting you confirm you are authorised to do so.')
    expect(BUYER_ACCEPT_HEADING).toBe('Accept this proposal')
    expect(buyerBasis('rentman.io', '2026-09-01')).toContain('based on a review of rentman.io')
    expect(buyerClosed('accepted')).toBe('This proposal has been accepted.')
    expect(buyerClosed('constructor')).toBe('This proposal is closed.')
  })
})

describe('the team’s side', () => {
  it('says the link is not the send, before anything else', () => {
    expect(SHARE_EXPLAINER).toContain('the link is not the send')
  })

  it('refuses Create in the order the route does', () => {
    expect(shareCreateBlocked({ status: 'draft', evidenceStale: true })).toMatch(/sent first/)
    expect(shareCreateBlocked({ status: 'accepted', evidenceStale: false })).toMatch(/accepted/)
    expect(shareCreateBlocked({ status: 'sent', evidenceStale: true })).toMatch(/stale/)
    expect(shareCreateBlocked({ status: 'sent', evidenceStale: false })).toBeNull()
  })

  it('names an accepted link accepted even after it was revoked or ran out', () => {
    const now = new Date('2026-09-10T00:00:00.000Z')
    const base = { revokedAt: null, acceptedAt: null, expiresAt: '2026-09-15T08:00:00.000Z' }
    expect(shareState(base, now)).toBe('live')
    expect(shareState({ ...base, expiresAt: '2026-09-10T00:00:00.000Z' }, now)).toBe('expired')
    expect(shareState({ ...base, revokedAt: '2026-09-09T00:00:00.000Z' }, now)).toBe('revoked')
    expect(shareState({ ...base, revokedAt: '2026-09-09T00:00:00.000Z', acceptedAt: '2026-09-08T00:00:00.000Z' }, now)).toBe('accepted')
  })
})

describe('the acceptance notification', () => {
  const OK: ShareAcceptResult = {
    ok: true,
    proposalId: '00000000-0000-4000-8000-0000000000aa',
    orgId: '00000000-0000-4000-8000-00000000000a',
    companyDomain: 'rentman.io',
    shareId: '00000000-0000-4000-8000-0000000000bb',
  }

  it('is the proposal_accepted event, via the share link, with ids and a domain only', () => {
    const event = shareAcceptedNotification(OK)
    expect(event).toEqual({
      kind: 'proposal_accepted',
      orgId: OK.orgId,
      proposalId: OK.proposalId,
      companyDomain: 'rentman.io',
      via: 'share_link',
    })
    const wire = JSON.stringify(slackMessage(event!, 'https://x.test'))
    expect(wire).toContain('through the share link')
    // The share's own id is not needed to act on it, and is not posted.
    expect(wire).not.toContain(OK.shareId)
  })

  it('posts nothing for a refusal', () => {
    for (const reason of ['not_found', 'expired', 'revoked', 'already_accepted', 'decided', 'blank_name', 'reverifying'] as const) {
      expect(shareAcceptedNotification({ ok: false, reason, status: 404 })).toBeNull()
    }
  })

  it('cannot carry the typed name: the result it is built from has none', () => {
    const decoy = { ...OK, acceptedByName: 'DECOY-NAME Jane Doe' } as ShareAcceptResult
    expect(JSON.stringify(shareAcceptedNotification(decoy))).not.toContain('DECOY')
  })
})

describe('the public surface, from the source', () => {
  const page = source('app/p/[token]/page.tsx')
  const accept = source('app/api/p/[token]/accept/route.ts')
  const share = source('app/api/proposals/[id]/share/route.ts')

  it('is dynamic and on the Node runtime — a cached public page keeps serving a revoked link', () => {
    for (const [name, src] of [['page', page], ['accept', accept], ['share', share]] as const) {
      expect(src, name).toMatch(/export const dynamic = 'force-dynamic'/)
      expect(src, name).toMatch(/export const runtime = 'nodejs'/)
    }
  })

  it('renders the stored document for the buyer, and keeps the URL out of a Referer header', () => {
    expect(page).toMatch(/audience="buyer"/)
    expect(page).not.toMatch(/audience="team"/)
    expect(page).toMatch(/referrer: 'no-referrer'/)
    expect(page).toMatch(/index: false/)
  })

  it('reads the accept body as text, bounded at 2 KB, before parsing it — the booking route’s idiom', () => {
    expect(accept).toMatch(/const MAX_BODY = 2 \* 1024/)
    const read = accept.indexOf('request.text()')
    const parse = accept.indexOf('JSON.parse(raw)')
    expect(read).toBeGreaterThan(0)
    expect(parse).toBeGreaterThan(read)
    expect(accept.slice(read, parse)).toMatch(/raw\.length > MAX_BODY/)
    expect(accept).not.toMatch(/request\.json\(\)/)
  })

  it('answers an acceptance with { ok: true } and no id', () => {
    const answers = [...accept.matchAll(/answer\(200, (\{[^}]*\})\)/g)].map((m) => m[1])
    expect(answers).toEqual(['{ ok: true }'])
    expect(accept).not.toMatch(/answer\([^)]*(proposalId|shareId|orgId)/)
  })

  it('never logs the token, the URL, or the typed name', () => {
    for (const [name, src] of [['page', page], ['accept', accept], ['share', share]] as const) {
      const logged = [...src.matchAll(/log\.(?:info|warn|error)\(([^)]*)\)/g)].map((m) => m[1] ?? '')
      expect(logged.length, name).toBeGreaterThan(0)
      for (const call of logged) {
        // `err.name` is the one name a log line here may carry: the error's class.
        expect(call.replace(/err\.name/g, ''), name).not.toMatch(/\btoken\b|\burl\b|\bname\b|acceptedByName/)
      }
    }
  })

  it('builds the link from AUTH_URL, never the request’s Host header', () => {
    expect(share).toMatch(/new URL\(`\/p\/\$\{r\.token\}`, env\(\)\.AUTH_URL\)/)
    expect(share).not.toMatch(/headers\.get\('host'\)|request\.url|nextUrl/)
  })
})
