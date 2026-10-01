/**
 * A proposal as Markdown (PROMPT.md §8.6, under §2.2 and §8.4).
 *
 * The file is the form a proposal most often leaves the building in, so the
 * tests are about what it must and must never say: the evidence verbatim
 * under every scope item; the two honest sentences §2.2 insists on (a
 * strength is "not the case here (…)", an unobserved signal is "not
 * assessed"); the stale banner exactly when the evidence has aged out; none
 * of the words that describe the product as something it is not; and nothing
 * from the stored JSON that the renderer was not written to quote.
 *
 * The document under test is the real generator's output over the seeded
 * ICP, not a hand-written one — the forbidden-words check is only worth
 * something against the prose the product actually writes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseIcpDefinition, proposalFromFindings, type Proposal, type ProposalFinding } from '@agency/core'
import {
  IN_PLACE_NOTE, NOT_ASSESSED_SENTENCE, PROPOSAL_EXPORT_NOTE, STALE_DRAFT_EXPORT_NOTE,
  isoDate, proposalMarkdownFilename, proposalToMarkdown, provenanceSentence, staleDraftRefusal,
  type ProposalMarkdownInput,
} from '../src/lib/proposal-markdown'

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const icp = parseIcpDefinition(JSON.parse(source('../../../packages/db/seed/icp-security-gap-saas.json')))
const RAN = new Date('2026-09-10T08:00:00.000Z')
const GENERATED = new Date('2026-09-12T09:30:00.000Z')
const GAPS = ['csp', 'hsts', 'security_txt', 'outdated_js']
const UNOBSERVED = ['trust_page', 'compliance_claim']

function findings(): ProposalFinding[] {
  return Object.entries(icp.signals).map(([key, s]) => {
    if (UNOBSERVED.includes(key)) {
      return { signalKey: key, observed: false, gap: null, weight: s.weight, detail: null, evidence: {} }
    }
    const gap = GAPS.includes(key)
    return {
      signalKey: key,
      observed: true,
      gap,
      weight: s.weight,
      detail: gap ? `${key} absent on the homepage response` : null,
      evidence: gap ? { url: 'https://www.rentman.io/', header: `${key}: (none)` } : { seen: 'present' },
    }
  })
}

function generated(): Proposal {
  const out = proposalFromFindings({
    company: { domain: 'rentman.io', name: 'Rentman' },
    agency: { name: 'Northwind AppSec' },
    icp,
    findings: findings(),
    scan: { ranAt: RAN, stale: false, ok: true },
    score: { score: 71, tier: 'A' },
    profiles: { activeProfileId: 'icp', scoreProfileId: 'icp' },
    dayRate: 1200,
    currency: 'USD',
    generatedAt: GENERATED,
  })
  if (!out.ok) throw new Error(`fixture did not generate: ${out.message}`)
  return out.proposal
}

const DOC = generated()

const input = (over: Partial<ProposalMarkdownInput> = {}): ProposalMarkdownInput => ({
  doc: DOC,
  company: { domain: 'rentman.io', name: 'Rentman' },
  agency: { name: 'Northwind AppSec' },
  status: 'draft',
  evidenceAsOf: RAN.toISOString(),
  evidenceStale: false,
  preparedBy: 'Priya Shah',
  ...over,
})

describe('the fixture', () => {
  it('has scope, strengths and unobserved signals, so every section below is exercised', () => {
    expect(DOC.workstreams.length).toBeGreaterThan(1)
    expect(DOC.alreadyInPlace.length).toBeGreaterThan(0)
    expect(DOC.notAssessed.map((s) => s.signalKey).sort()).toEqual([...UNOBSERVED].sort())
  })
})

describe('what the file never says', () => {
  const variants = [
    proposalToMarkdown(input()),
    proposalToMarkdown(input({ evidenceStale: true, status: 'sent' })),
    proposalToMarkdown(input({ status: 'accepted', preparedBy: null })),
    proposalToMarkdown(input({ evidenceAsOf: null })),
  ]

  it('never describes the review as a test, a pentest or a probe', () => {
    for (const md of variants) {
      expect(md).not.toMatch(/\b(pen)?test(s|ed|ing)?\b/i)
      expect(md).not.toMatch(/\bpen-?test/i)
      expect(md).not.toMatch(/\bprob(e|es|ed|ing)\b/i)
    }
    // …and the sentences the route and the page say around it do not either.
    for (const s of [PROPOSAL_EXPORT_NOTE, STALE_DRAFT_EXPORT_NOTE, staleDraftRefusal('rentman.io'), provenanceSentence('rentman.io', '2026-09-10')]) {
      expect(s).not.toMatch(/\b(pen)?test(s|ed|ing)?\b|\bprob(e|es|ed|ing)\b/i)
    }
  })

  it('calls it posture review from the outside', () => {
    expect(variants[0]).toContain('this is posture review from the outside')
  })

  it('carries no score, tier or weight — how the pipeline ranks a prospect is not the buyer’s business', () => {
    for (const md of variants) {
      expect(md).not.toMatch(/\bscore\b/i)
      expect(md).not.toMatch(/\btier\b/i)
      expect(md).not.toMatch(/\bweight\b/i)
      expect(md).not.toContain('71/100')
    }
  })

  it('never quotes a field of the stored JSON it was not written to read', () => {
    const [ws, ...rest] = DOC.workstreams
    const item = ws!.items[0]!
    const decoy = {
      ...DOC,
      notes: 'DECOY-TOP-LEVEL do not forward to the buyer',
      workstreams: [
        { ...ws!, internal: 'DECOY-WORKSTREAM', items: [{ ...item, notes: 'DECOY-ITEM' }, ...ws!.items.slice(1)] },
        ...rest,
      ],
    } as unknown as Proposal
    const md = proposalToMarkdown(input({ doc: decoy }))
    expect(md).not.toContain('DECOY')
    // …and removing them changes nothing at all.
    expect(md).toBe(proposalToMarkdown(input()))
  })
})

describe('the evidence', () => {
  const md = proposalToMarkdown(input())

  it('puts every scope item’s evidence lines in the file verbatim, inside a fence', () => {
    const blocks = [...md.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)].map((m) => m[2]!)
    const items = DOC.workstreams.flatMap((w) => w.items)
    expect(blocks).toHaveLength(items.length)
    items.forEach((item, i) => {
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(blocks[i]).toBe(item.evidence.join('\n'))
      for (const line of item.evidence) expect(md).toContain(line)
    })
  })

  it('keeps a line verbatim even when the site served backticks, by fencing longer than any run inside', () => {
    const hostile = '```\n# not a heading\n````'
    const ws = DOC.workstreams[0]!
    const doc = {
      ...DOC,
      workstreams: [{ ...ws, items: [{ ...ws.items[0]!, evidence: ['plain line', hostile] }] }],
    } as Proposal
    const out = proposalToMarkdown(input({ doc }))
    expect(out).toContain(`\`\`\`\`\`text\nplain line\n${hostile}\n\`\`\`\`\``)
  })

  it('says so, rather than printing an empty fence, when an item carries no evidence lines', () => {
    const ws = DOC.workstreams[0]!
    const doc = { ...DOC, workstreams: [{ ...ws, items: [{ ...ws.items[0]!, evidence: [] }] }] } as Proposal
    expect(proposalToMarkdown(input({ doc }))).toContain('_No evidence lines were recorded for this item._')
  })
})

describe('the two sentences §2.2 insists on', () => {
  const md = proposalToMarkdown(input())

  it('frames every strength as "not the case here (…)", with the bracket identified as what the scan looks for', () => {
    expect(md).toContain(IN_PLACE_NOTE)
    for (const s of DOC.alreadyInPlace) expect(md).toContain(`\`${s.signalKey}\` — not the case here (${s.why})`)
  })

  it('lists what could not be observed as not assessed, never as fine', () => {
    expect(md).toContain('## Not assessed')
    expect(md).toContain(NOT_ASSESSED_SENTENCE)
    for (const s of DOC.notAssessed) expect(md).toContain(`\`${s.signalKey}\` — ${s.why}`)
  })

  it('uses the same words the proposal page renders, so the two cannot drift apart', () => {
    const page = flat(source('../src/components/pipeline/proposal-document.tsx'))
    expect(page).toContain(IN_PLACE_NOTE)
    expect(page).toContain(NOT_ASSESSED_SENTENCE)
    expect(page).toContain('not the case here (')
  })

  it('leaves both sections out when there is nothing to put in them, rather than an empty heading', () => {
    const md2 = proposalToMarkdown(input({ doc: { ...DOC, alreadyInPlace: [], notAssessed: [] } }))
    expect(md2).not.toContain('## Already in place')
    expect(md2).not.toContain('## Not assessed')
  })
})

describe('the stale banner', () => {
  it('is present when the caller derived the evidence as stale', () => {
    const md = proposalToMarkdown(input({ evidenceStale: true, status: 'sent' }))
    expect(md).toContain('> **The evidence under this proposal has aged out — re-verify before it appears in anything outbound.**')
    expect(md).toContain('It was written from a scan that ran on 2026-09-10.')
    expect(md).toContain('Re-scan rentman.io and generate a fresh proposal rather than sending this copy.')
  })

  it('is absent otherwise', () => {
    const md = proposalToMarkdown(input({ evidenceStale: false }))
    expect(md).not.toContain('aged out')
    expect(md).not.toContain('re-verify')
    expect(md).not.toMatch(/^>/m)
  })

  it('follows the flag it is handed and nothing stored in the document', () => {
    // The generator only writes from a fresh scan, so the stored JSON can
    // never say "stale". Freshness is the caller's derivation from ran_at.
    expect(proposalToMarkdown(input({ evidenceStale: true }))).toContain('aged out')
  })

  it('dates the evidence from the scan row when there is one, and from the document when it is gone', () => {
    expect(proposalToMarkdown(input({ evidenceAsOf: '2026-08-01T00:00:00.000Z', evidenceStale: true }))).toContain(
      'ran on 2026-08-01',
    )
    expect(proposalToMarkdown(input({ evidenceAsOf: null, evidenceStale: true }))).toContain('ran on 2026-09-10')
  })
})

describe('the header', () => {
  it('names the company, the person and the agency, joined at read time', () => {
    const md = proposalToMarkdown(input())
    expect(md.startsWith(`# ${DOC.title}\n`)).toBe(true)
    expect(md).toContain('Prepared for Rentman by Priya Shah, Northwind AppSec.')
    expect(proposalToMarkdown(input({ preparedBy: null }))).toContain('Prepared for Rentman by Northwind AppSec.')
    expect(proposalToMarkdown(input({ company: { domain: 'rentman.io', name: null } }))).toContain('Prepared for rentman.io by')
  })

  it('says how it ended when it has, and says nothing internal about a draft or a sent one', () => {
    expect(proposalToMarkdown(input({ status: 'accepted' }))).toContain('Status: accepted.')
    expect(proposalToMarkdown(input({ status: 'withdrawn' }))).toContain('Status: withdrawn.')
    expect(proposalToMarkdown(input({ status: 'draft' }))).not.toContain('Status:')
    expect(proposalToMarkdown(input({ status: 'sent' }))).not.toContain('Status:')
  })

  it('carries the pricing the document stored, and says when there is no day rate', () => {
    const md = proposalToMarkdown(input())
    expect(md).toContain(`| Day rate | USD 1,200 |`)
    const noRate = { ...DOC, pricing: { ...DOC.pricing, dayRate: null, total: null } }
    const md2 = proposalToMarkdown(input({ doc: noRate }))
    expect(md2).toContain('| Day rate | not set — effort only |')
    expect(md2).toContain('| Total | — |')
  })
})

describe('somebody else’s strings stay text', () => {
  it('escapes a company name that would otherwise be markup', () => {
    const md = proposalToMarkdown(input({ company: { domain: 'acme.io', name: 'Acme *Corp* <img src=x onerror=alert(1)> [x](javascript:y)' } }))
    expect(md).not.toMatch(/(^|[^\\])<img/m)
    expect(md).not.toContain('*Corp*')
    expect(md).not.toContain('[x](')
    expect(md).toContain('Acme \\*Corp\\* \\<img src=x onerror=alert(1)\\> \\[x\\](javascript:y)')
  })

  it('cannot start a heading, a list or a quote from inside a value', () => {
    const doc = {
      ...DOC,
      assumptions: ['# a heading\n\n- a list\n> a quote', '1. numbered'],
    } as Proposal
    const md = proposalToMarkdown(input({ doc }))
    expect(md).toContain('- \\# a heading - a list \\> a quote')
    expect(md).toContain('- 1\\. numbered')
    expect(md).not.toMatch(/^# a heading/m)
    expect(md).not.toMatch(/^- a list/m)
  })

  it('ends with exactly one newline and is the same every time it is asked', () => {
    const md = proposalToMarkdown(input())
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
    expect(proposalToMarkdown(input())).toBe(md)
  })
})

describe('the download name', () => {
  it('is the domain and the generation date', () => {
    expect(proposalMarkdownFilename('Rentman.io', GENERATED.toISOString())).toBe('proposal-rentman.io-2026-09-12.md')
  })

  it('holds nothing a header, a shell or a file system could misread', () => {
    const name = proposalMarkdownFilename('evil"; rm -rf /\r\n.inbound', 'not a date')
    expect(name).toMatch(/^proposal-[a-z0-9.-]+\.md$/)
    expect(proposalMarkdownFilename('', GENERATED.toISOString())).toBe('proposal-company-2026-09-12.md')
  })
})

describe('isoDate', () => {
  it('never guesses a date it cannot read', () => {
    expect(isoDate('2026-09-10T23:59:00.000-05:00')).toBe('2026-09-11')
    expect(isoDate(null)).toBe('an unrecorded date')
    expect(isoDate('yesterday')).toBe('an unrecorded date')
  })
})

describe('the copy around the links', () => {
  it('is the words the brief fixed, and says nothing here sends', () => {
    expect(PROPOSAL_EXPORT_NOTE).toBe(
      "The document is the JSON stored when it was generated. Sending it is a person's act, done from their own mail — nothing here sends.",
    )
  })

  it('refuses a stale draft with the reason and the fix', () => {
    const m = staleDraftRefusal('rentman.io')
    expect(m).toContain('re-verify before it appears in anything outbound')
    expect(m).toContain('Re-scan rentman.io')
    expect(STALE_DRAFT_EXPORT_NOTE).toContain('re-verify before it appears in anything outbound')
  })
})

describe('nothing on this path sends (§8.4)', () => {
  const files = {
    route: source('../src/app/api/proposals/[id]/markdown/route.ts'),
    print: source('../src/app/proposals/[id]/print/page.tsx'),
    links: source('../src/components/pipeline/proposal-links.tsx'),
  }

  it('imports no transport and calls no provider', () => {
    for (const [name, src] of Object.entries(files)) {
      expect(src, name).not.toMatch(/smtp|nodemailer|dispatchTouch|sendMail|queueTouch|@\/lib\/mail/i)
      expect(src, name).not.toMatch(/\bfetch\(/)
    }
  })

  it('the route reads under deals:read, refuses a stale draft with reason "stale", and audits the export', () => {
    expect(files.route).toContain("'deals:read'")
    expect(files.route).toMatch(/row\.status === 'draft' && evidenceStale/)
    expect(files.route).toContain("reason: 'stale'")
    expect(files.route).toContain('status: 409')
    expect(files.route).toContain("action: 'proposal.exported'")
    expect(files.route).toContain("format: 'markdown'")
  })

  it('the print view renders the stored document for the team, with no Shell, and audits the export', () => {
    expect(files.print).toContain('audience="team"')
    expect(files.print).not.toMatch(/<Shell\b/)
    expect(files.print).not.toMatch(/proposalFromFindings|generateProposal/)
    expect(files.print).toContain("action: 'proposal.exported'")
    expect(files.print).toContain("format: 'print'")
  })

  it('the slot renders both links and the note, and no download link for a stale draft', () => {
    expect(files.links).toContain('>Print<')
    expect(files.links).toContain('Download as Markdown')
    expect(files.links).toContain('PROPOSAL_EXPORT_NOTE')
    expect(files.links).toContain('STALE_DRAFT_EXPORT_NOTE')
    expect(files.links).not.toContain('STUB')
  })
})
