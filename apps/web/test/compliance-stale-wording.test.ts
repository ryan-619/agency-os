/**
 * /compliance says what the send path does with a message waiting on stale
 * evidence, rather than what it did before the review round.
 *
 * The round-1 review added `stale_evidence` to `decideSend`, and the sender
 * refuses a message whose words were written from a scan that is stale at
 * the moment of sending — approved, queued or sending alike. The page still
 * said those three "go with nobody looking at the evidence again", which is
 * true only of a message with no successful scan behind it or an answer to a
 * reply. `complianceDraftsOnStaleEvidence` now says which is which per row;
 * the page cannot be imported here (it imports `@/auth`), so it is read.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('../src/app/compliance/page.tsx', import.meta.url)), 'utf8')
const block = src.slice(src.indexOf('function DraftsOnStale('), src.indexOf('function Consents('))
/** The prose as a person reads it: tags, entities and line breaks collapsed. */
const prose = block.replace(/<[^>]+>/g, '').replace(/&apos;/g, "'").replace(/\s+/g, ' ')

describe('/compliance on messages waiting to go on stale or missing evidence', () => {
  it('no longer says approved, queued and sending rows go with nobody looking at the evidence', () => {
    expect(prose).not.toContain('go with nobody looking at the evidence again')
    expect(block).not.toMatch(/const noLook = d\.count - d\.byStatus\.awaiting_approval/)
  })

  it('says the send path refuses a stale-evidence row at sending, and which rows it does not judge', () => {
    expect(prose).toContain('The send path refuses a message at sending when the scan its words were written from is stale (stale_evidence), whoever approved it')
    expect(prose).toContain('It does not judge by evidence a message with no successful scan behind it, or an answer to a reply')
  })

  it('splits the count by what happens at sending, from the fields the summary carries', () => {
    for (const field of ['d.refusedAtSending', 'd.notJudgedAtSending', 'd.notJudgedNoFurtherLook', 'r.refusedAtSending', 'r.writtenFromScanAt']) {
      expect(block).toContain(field)
    }
    expect(block).toContain("r.why === 'rescanned_since'")
    expect(prose).toContain('refused — stale evidence')
  })

  /**
   * Round 4: the sender also refuses words written from a scan that is still
   * fresh when a newer successful scan exists. The count lists those as
   * `superseded`; the page names the reason per row and in its rule, rather
   * than leaving a listed row its prose does not account for.
   */
  it('words a row listed because a newer scan superseded the one its words quote', () => {
    expect(block).toContain("r.why === 'superseded'")
    expect(prose).toContain('superseded by the newer scan of')
    expect(prose).toContain('or that a newer successful scan has superseded')
    expect(prose).toContain('and when a newer successful scan has superseded it')
  })

  /**
   * The refused-at-sending count holds superseded rows too, whose company
   * has just been re-scanned — "re-scan, then draft again" sent a person to
   * do what already happened. The fix true of both is a new draft from a
   * current scan. Round 4 (integrator).
   */
  it('labels the refused-at-sending count with a fix true of a superseded row as well as an aged one', () => {
    const label = /<Count n=\{d\.refusedAtSending\} label="([^"]+)"/.exec(block)?.[1]
    expect(label).toBe('…of which refused at sending (stale or superseded evidence) — draft again from a current scan')
    expect(label).not.toMatch(/re-scan/)
  })
})
