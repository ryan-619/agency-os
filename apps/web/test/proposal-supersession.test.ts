/**
 * A proposal whose scan has been superseded says so wherever it is handed on.
 *
 * Only the most recent successful scan is quoted in anything outbound
 * (§2.2, `quotableFindings`), and the share link already treats a newer
 * successful scan as "being re-verified" (`shareEvidenceSuperseded`). The
 * Markdown export refused a DRAFT only when its own scan was stale, and the
 * print view, the proposal page and the download links said nothing — so a
 * draft generated from S1, with a fresh S2 since showing a priced gap closed,
 * downloaded with no warning and priced work the newest observation says is
 * not needed. Review round 3, finding [6].
 *
 * The copy is pure and imported; the route and the pages import `@/auth`,
 * so they are read.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  STALE_DRAFT_EXPORT_NOTE, SUPERSEDED_DRAFT_EXPORT_NOTE, staleDraftRefusal, supersededBannerText,
  supersededDraftRefusal,
} from '../src/lib/proposal-markdown'

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the words', () => {
  it('refuses a superseded draft with the reason and the fix, distinct from a stale one', () => {
    const m = supersededDraftRefusal('rentman.io')
    expect(m).toContain('A newer scan of rentman.io exists')
    expect(m).toContain('re-verify before it appears in anything outbound')
    expect(m).toContain('generate a fresh proposal from the newer scan')
    expect(m).not.toBe(staleDraftRefusal('rentman.io'))
    expect(SUPERSEDED_DRAFT_EXPORT_NOTE).toContain('a newer scan of the company exists')
    expect(SUPERSEDED_DRAFT_EXPORT_NOTE).not.toBe(STALE_DRAFT_EXPORT_NOTE)
  })

  it('banners a superseded proposal without calling the review a test', () => {
    const b = supersededBannerText('rentman.io')
    expect(b.lead).toContain('A newer scan of rentman.io exists')
    expect(b.rest).toContain('Generate a fresh proposal from it')
    expect(`${b.lead} ${b.rest}`).not.toMatch(/pentest|penetration|probe|security test/i)
  })
})

describe('the Markdown route', () => {
  const route = source('../src/app/api/proposals/[id]/markdown/route.ts')

  it('asks whether the evidence is superseded', () => {
    expect(route).toContain('shareEvidenceSuperseded(db, user.orgId, row.id)')
  })

  it('refuses a superseded DRAFT with 409, reason "superseded", and keeps the stale refusal', () => {
    expect(route).toMatch(/row\.status === 'draft' && evidenceStale/)
    expect(route).toMatch(/row\.status === 'draft' && evidenceSuperseded/)
    expect(route).toContain("reason: 'superseded'")
    expect(route).toContain('supersededDraftRefusal(company.domain)')
  })
})

describe('the download links', () => {
  const links = source('../src/components/pipeline/proposal-links.tsx')

  it('offer no download for a superseded draft, and say why', () => {
    expect(links).toMatch(/status === 'draft' && \(evidenceStale \|\| evidenceSuperseded\)/)
    expect(links).toContain('SUPERSEDED_DRAFT_EXPORT_NOTE')
  })
})

describe('the proposal page', () => {
  const page = source('../src/app/proposals/[id]/page.tsx')

  it('reads supersession, warns, and hands it to the links', () => {
    expect(page).toContain('shareEvidenceSuperseded(db, user.orgId, row.id)')
    expect(page).toContain('supersededBannerText(company.domain)')
    expect(page).toMatch(/<ProposalLinksSlot \{\.\.\.slot\} evidenceSuperseded=\{evidenceSuperseded\} \/>/)
  })
})

describe('the print view', () => {
  const print = source('../src/app/proposals/[id]/print/page.tsx')

  it('reads supersession and prints the banner', () => {
    expect(print).toContain('shareEvidenceSuperseded(db, orgId, row.id)')
    expect(print).toContain('supersededBannerText(company.domain)')
    expect(print).toMatch(/evidenceSuperseded \? \(/)
  })
})
